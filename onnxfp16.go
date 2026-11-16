package main

// Перевод модели ONNX из float32 в float16 прямо в программе: официальный файл качается с проверкой sha256,
// а половинную точность делаем сами (своего хостинга нет). Для BiRefNet-matting это 927 → 506 МБ и 0,15 с на картинку
// вместо 3,4 с через DirectML. Разбор protobuf минимальный: поле = номер, тип провода, сырые байты.
// Правила перевода:
//   - вход и выход модели остаются float32 (Cast на входе и выходе);
//   - Resize и подобные (onnxKeep32) считаются во float32, их выход сразу возвращается в fp16, если данные пришли в fp16;
//   - ветки расчёта размеров (Cast to=float от целых) остаются float32;
//   - веса и Constant подстраиваются под потребителя (у одного веса может быть две копии);
//   - Identity от веса — просто другое имя того же веса (иначе общие веса второго прохода остаются во float32);
//   - value_info выкидывается: ORT выводит типы сам.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"maps"
	"math"
	"slices"
)

type pbField struct {
	num  int
	wt   int
	val  uint64 // для wt 0, 1, 5
	data []byte // для wt 2
}

var errPB = errors.New("onnx: bad protobuf")

func pbParse(b []byte) ([]pbField, error) {
	var fs []pbField
	for len(b) > 0 {
		key, n := binary.Uvarint(b)
		if n <= 0 {
			return nil, errPB
		}
		b = b[n:]
		f := pbField{num: int(key >> 3), wt: int(key & 7)}
		switch f.wt {
		case 0:
			v, n := binary.Uvarint(b)
			if n <= 0 {
				return nil, errPB
			}
			f.val, b = v, b[n:]
		case 1:
			if len(b) < 8 {
				return nil, errPB
			}
			f.val, b = binary.LittleEndian.Uint64(b), b[8:]
		case 5:
			if len(b) < 4 {
				return nil, errPB
			}
			f.val, b = uint64(binary.LittleEndian.Uint32(b)), b[4:]
		case 2:
			l, n := binary.Uvarint(b)
			if n <= 0 || l > uint64(len(b)-n) {
				return nil, errPB
			}
			f.data, b = b[n:n+int(l)], b[n+int(l):]
		default:
			return nil, errPB
		}
		fs = append(fs, f)
	}
	return fs, nil
}

func pbEnc(fs []pbField) []byte {
	size := 0
	for _, f := range fs {
		size += 12 + len(f.data)
	}
	o := make([]byte, 0, size)
	for _, f := range fs {
		o = binary.AppendUvarint(o, uint64(f.num<<3|f.wt))
		switch f.wt {
		case 0:
			o = binary.AppendUvarint(o, f.val)
		case 1:
			o = binary.LittleEndian.AppendUint64(o, f.val)
		case 5:
			o = binary.LittleEndian.AppendUint32(o, uint32(f.val))
		case 2:
			o = binary.AppendUvarint(o, uint64(len(f.data)))
			o = append(o, f.data...)
		}
	}
	return o
}

func pbInt(n int, v uint64) pbField   { return pbField{num: n, wt: 0, val: v} }
func pbBytes(n int, b []byte) pbField { return pbField{num: n, wt: 2, data: b} }
func pbStr(n int, s string) pbField   { return pbField{num: n, wt: 2, data: []byte(s)} }

func pbGet(fs []pbField, n int) *pbField {
	for i := range fs {
		if fs[i].num == n {
			return &fs[i]
		}
	}
	return nil
}

func pbGetStr(fs []pbField, n int) string {
	if f := pbGet(fs, n); f != nil {
		return string(f.data)
	}
	return ""
}

func pbGetInt(fs []pbField, n int) int {
	if f := pbGet(fs, n); f != nil {
		return int(f.val)
	}
	return 0
}

func pbStrs(fs []pbField, n int) []string {
	var r []string
	for _, f := range fs {
		if f.num == n {
			r = append(r, string(f.data))
		}
	}
	return r
}

// типы элементов ONNX
const (
	onnxFloat = 1
	onnxInt64 = 7
	onnxBool  = 9
	onnxF16   = 10
)

// onnxKeep32: узлы, которые остаются во float32 (как у onnxconverter-common)
var onnxKeep32 = map[string]bool{"Resize": true, "Range": true, "TopK": true, "NonMaxSuppression": true, "RoiAlign": true, "CumSum": true}

// onnxFixedF32: вход операции, который всегда float32 (масштабы Resize), а не данные
func onnxFixedF32(op string, i int) bool { return op == "Resize" && (i == 1 || i == 2) }

type onnxInfo struct {
	typ  int  // тип элемента; 0 — неизвестно
	flex bool // константа или вес: точность выбирает потребитель
}

type onnxNode struct {
	f   []pbField
	op  string
	in  []string
	out []string
}

// onnxToFP16 переводит модель (байты .onnx) в половинную точность
func onnxToFP16(model []byte) ([]byte, error) {
	m, err := pbParse(model)
	if err != nil {
		return nil, err
	}
	gf := pbGet(m, 7)
	if gf == nil {
		return nil, errors.New("onnx: no graph")
	}
	g, err := pbParse(gf.data)
	if err != nil {
		return nil, err
	}
	info := map[string]*onnxInfo{}
	inits := map[string][]pbField{}
	var nodes []onnxNode
	var inNames, outNames []string
	for _, f := range g {
		switch f.num {
		case 1:
			n, err := pbParse(f.data)
			if err != nil {
				return nil, err
			}
			nodes = append(nodes, onnxNode{f: n, op: pbGetStr(n, 4), in: pbStrs(n, 1), out: pbStrs(n, 2)})
		case 5:
			t, err := pbParse(f.data)
			if err != nil {
				return nil, err
			}
			name := pbGetStr(t, 8)
			inits[name] = t
			info[name] = &onnxInfo{typ: pbGetInt(t, 2), flex: true}
		case 11:
			v, _ := pbParse(f.data)
			inNames = append(inNames, pbGetStr(v, 1))
		case 12:
			v, _ := pbParse(f.data)
			outNames = append(outNames, pbGetStr(v, 1))
		}
	}
	for _, n := range inNames {
		if _, ok := info[n]; !ok {
			info[n] = &onnxInfo{typ: onnxF16} // станет fp16 через Cast
		}
	}
	isFloat := func(name string) bool {
		t := info[name]
		return t != nil && (t.typ == onnxFloat || t.typ == onnxF16)
	}
	isOut := func(o string) bool {
		for _, x := range outNames {
			if x == o {
				return true
			}
		}
		return false
	}

	var out []onnxNode
	newInits := map[string][]pbField{}
	casts := map[string]string{}
	castTo := func(name string, to int, before *[]onnxNode) string {
		key := fmt.Sprint(name, "|", to)
		if c, ok := casts[key]; ok {
			return c
		}
		c := fmt.Sprintf("%s_cast%d", name, to)
		*before = append(*before, onnxCast(name, c, to))
		info[c] = &onnxInfo{typ: to}
		casts[key] = c
		return c
	}
	// вес нужной точности: копия рядом с исходным
	initAs := func(name string, to int) string {
		if info[name].typ == to {
			return name
		}
		t, ok := inits[name]
		if !ok {
			return name
		}
		nn := fmt.Sprintf("%s_t%d", name, to)
		if _, done := newInits[nn]; !done {
			newInits[nn] = onnxConvTensor(t, to, nn)
			info[nn] = &onnxInfo{typ: to, flex: true}
		}
		return nn
	}
	// Constant нужной точности: новый узел-копия
	constAs := func(cn *onnxNode, name string, to int) string {
		nn := fmt.Sprintf("%s_c%d", name, to)
		if _, ok := info[nn]; ok {
			return nn
		}
		nt := onnxConvTensor(onnxConstTensor(cn.f), to, "")
		attr := []pbField{pbStr(1, "value"), pbBytes(5, pbEnc(nt)), pbInt(20, 4)}
		f := []pbField{pbStr(2, nn), pbStr(3, nn+"_node"), pbStr(4, "Constant"), pbBytes(5, pbEnc(attr))}
		out = append(out, onnxNode{f: f, op: "Constant", out: []string{nn}})
		info[nn] = &onnxInfo{typ: to, flex: true}
		return nn
	}

	// входы: Cast float → fp16
	rename := map[string]string{}
	for _, n := range inNames {
		c := n + "_fp16"
		out = append(out, onnxCast(n, c, onnxF16))
		info[c] = &onnxInfo{typ: onnxF16}
		rename[n] = c
	}

	consts := map[string]*onnxNode{}
	for i := range nodes {
		n := &nodes[i]
		for j, x := range n.in {
			if r, ok := rename[x]; ok {
				n.in[j] = r
			}
		}
		if n.op == "Constant" {
			t := onnxConstTensor(n.f)
			typ := 0
			if t != nil {
				typ = pbGetInt(t, 2)
			}
			info[n.out[0]] = &onnxInfo{typ: typ, flex: t != nil && typ == onnxFloat}
			consts[n.out[0]] = n
			out = append(out, *n)
			continue
		}
		if n.op == "Identity" && len(n.in) == 1 && info[n.in[0]] != nil && info[n.in[0]].flex && !isOut(n.out[0]) {
			rename[n.out[0]] = n.in[0]
			continue
		}
		dataWas16 := false
		for j, x := range n.in {
			if x != "" && !onnxFixedF32(n.op, j) && isFloat(x) && !info[x].flex && info[x].typ == onnxF16 {
				dataWas16 = true
			}
		}
		// точность узла: по данным (не по весам)
		prec := 0
		if onnxKeep32[n.op] {
			prec = onnxFloat
		} else {
			for j, x := range n.in {
				if x == "" || onnxFixedF32(n.op, j) || !isFloat(x) || info[x].flex {
					continue
				}
				if info[x].typ == onnxF16 {
					prec = onnxF16
					break
				}
				prec = onnxFloat
			}
			if prec == 0 {
				prec = onnxFloat // одни константы: как было
			}
		}
		var before []onnxNode
		if n.op != "Cast" { // вход Cast любого типа
			for j, x := range n.in {
				if x == "" || !isFloat(x) {
					continue
				}
				want := prec
				if onnxFixedF32(n.op, j) {
					want = onnxFloat
				}
				if info[x].typ == want {
					continue
				}
				if info[x].flex {
					if cn, ok := consts[x]; ok {
						n.in[j] = constAs(cn, x, want)
					} else {
						n.in[j] = initAs(x, want)
					}
					continue
				}
				n.in[j] = castTo(x, want, &before)
			}
		}
		// типы выходов
		switch n.op {
		case "Shape", "Size", "NonZero", "ArgMax", "ArgMin":
			onnxSetOut(info, n.out, onnxInt64)
		case "Equal", "Not", "Less", "Greater", "And", "Or", "IsNaN":
			onnxSetOut(info, n.out, onnxBool)
		case "Cast":
			to := onnxAttrInt(n.f, "to")
			if to == onnxFloat && isFloat(n.in[0]) {
				to = int64(info[n.in[0]].typ) // float → float: идёт дальше в той же точности
				onnxSetAttrInt(n.f, "to", to)
			}
			onnxSetOut(info, n.out, int(to))
		case "ConstantOfShape":
			typ := onnxFloat
			if t := onnxConstTensor(n.f); t != nil {
				typ = pbGetInt(t, 2)
			}
			onnxSetOut(info, n.out, typ)
		default:
			src := 0
			if n.op == "Where" {
				src = 1
			}
			typ := 0
			if src < len(n.in) && info[n.in[src]] != nil {
				typ = info[n.in[src]].typ
			}
			if typ == onnxFloat || typ == onnxF16 {
				typ = prec
			}
			if typ == 0 {
				return nil, fmt.Errorf("onnx: output type of %s unknown", n.op)
			}
			onnxSetOut(info, n.out, typ)
		}
		onnxSetList(n.f, 1, n.in)
		out = append(out, before...)
		out = append(out, *n)
		// узел во float32 на пути данных fp16: выход сразу обратно в fp16
		if onnxKeep32[n.op] && dataWas16 {
			for _, o := range n.out {
				if o == "" || !isFloat(o) || isOut(o) {
					continue
				}
				r := o + "_r16"
				out = append(out, onnxCast(o, r, onnxF16))
				info[r] = &onnxInfo{typ: onnxF16}
				rename[o] = r
			}
		}
	}
	// выходы: обратно во float32
	for _, o := range outNames {
		if info[o] == nil || info[o].typ == onnxFloat {
			continue
		}
		r := o + "_fp16out"
		for i := range out {
			for j, x := range out[i].out {
				if x == o {
					out[i].out[j] = r
					onnxSetList(out[i].f, 2, out[i].out)
				}
			}
			for j, x := range out[i].in {
				if x == o {
					out[i].in[j] = r
					onnxSetList(out[i].f, 1, out[i].in)
				}
			}
		}
		out = append(out, onnxCast(r, o, onnxFloat))
	}

	used := map[string]bool{}
	for _, n := range out {
		for _, x := range n.in {
			used[x] = true
		}
	}
	var ng []pbField
	for _, f := range g {
		switch f.num {
		case 1, 13: // узлы пишутся заново, value_info не нужен
			continue
		case 5:
			t, _ := pbParse(f.data)
			if used[pbGetStr(t, 8)] {
				ng = append(ng, f)
			}
			continue
		}
		ng = append(ng, f)
	}
	for _, name := range slices.Sorted(maps.Keys(newInits)) { // по порядку: один и тот же файл на выходе
		if used[name] {
			ng = append(ng, pbBytes(5, pbEnc(newInits[name])))
		}
	}
	for _, n := range out {
		ng = append(ng, pbBytes(1, pbEnc(n.f)))
	}
	nm := make([]pbField, len(m))
	copy(nm, m)
	for i := range nm {
		if nm[i].num == 7 {
			nm[i].data = pbEnc(ng)
		}
	}
	return pbEnc(nm), nil
}

func onnxSetOut(info map[string]*onnxInfo, outs []string, typ int) {
	for _, o := range outs {
		if o != "" {
			info[o] = &onnxInfo{typ: typ}
		}
	}
}

func onnxCast(in, out string, to int) onnxNode {
	attr := []pbField{pbStr(1, "to"), pbInt(3, uint64(to)), pbInt(20, 2)}
	f := []pbField{pbStr(1, in), pbStr(2, out), pbStr(3, out+"_node"), pbStr(4, "Cast"), pbBytes(5, pbEnc(attr))}
	return onnxNode{f: f, op: "Cast", in: []string{in}, out: []string{out}}
}

// onnxSetList переписывает повторяющееся поле num (входы 1 или выходы 2) по списку
func onnxSetList(nf []pbField, num int, vals []string) {
	k := 0
	for i := range nf {
		if nf[i].num == num && k < len(vals) {
			nf[i].data = []byte(vals[k])
			k++
		}
	}
}

func onnxAttrInt(nf []pbField, name string) int64 {
	for _, a := range nf {
		if a.num == 5 {
			af, _ := pbParse(a.data)
			if pbGetStr(af, 1) == name {
				return int64(pbGetInt(af, 3))
			}
		}
	}
	return -1
}

func onnxSetAttrInt(nf []pbField, name string, v int64) {
	for i, a := range nf {
		if a.num == 5 {
			af, _ := pbParse(a.data)
			if pbGetStr(af, 1) == name {
				if f := pbGet(af, 3); f != nil {
					f.val = uint64(v)
					nf[i].data = pbEnc(af)
				}
			}
		}
	}
}

// onnxConstTensor: TensorProto из атрибута value (Constant, ConstantOfShape)
func onnxConstTensor(nf []pbField) []pbField {
	for _, a := range nf {
		if a.num == 5 {
			af, _ := pbParse(a.data)
			if pbGetStr(af, 1) == "value" {
				if t := pbGet(af, 5); t != nil {
					tf, _ := pbParse(t.data)
					return tf
				}
			}
		}
	}
	return nil
}

// onnxConvTensor переводит TensorProto float32 ↔ float16 (в raw_data). name — новое имя (пусто — прежнее).
func onnxConvTensor(t []pbField, to int, name string) []pbField {
	from := pbGetInt(t, 2)
	var vals []float32
	if r := pbGet(t, 9); r != nil {
		if from == onnxFloat {
			for i := 0; i+4 <= len(r.data); i += 4 {
				vals = append(vals, math.Float32frombits(binary.LittleEndian.Uint32(r.data[i:])))
			}
		} else {
			for i := 0; i+2 <= len(r.data); i += 2 {
				vals = append(vals, f16to32(binary.LittleEndian.Uint16(r.data[i:])))
			}
		}
	} else {
		for _, f := range t {
			if f.num == 4 { // float_data, упакованный или нет
				if f.wt == 2 {
					for i := 0; i+4 <= len(f.data); i += 4 {
						vals = append(vals, math.Float32frombits(binary.LittleEndian.Uint32(f.data[i:])))
					}
				} else {
					vals = append(vals, math.Float32frombits(uint32(f.val)))
				}
			}
			if f.num == 5 && from == onnxF16 { // int32_data у fp16
				if f.wt == 2 {
					b := f.data
					for len(b) > 0 {
						v, n := binary.Uvarint(b)
						if n <= 0 {
							break
						}
						vals = append(vals, f16to32(uint16(v)))
						b = b[n:]
					}
				} else {
					vals = append(vals, f16to32(uint16(f.val)))
				}
			}
		}
	}
	sz := 4
	if to == onnxF16 {
		sz = 2
	}
	raw := make([]byte, 0, len(vals)*sz)
	for _, v := range vals {
		if to == onnxF16 {
			raw = binary.LittleEndian.AppendUint16(raw, f32to16(v))
		} else {
			raw = binary.LittleEndian.AppendUint32(raw, math.Float32bits(v))
		}
	}
	var nt []pbField
	for _, f := range t {
		switch f.num {
		case 2:
			nt = append(nt, pbInt(2, uint64(to)))
		case 4, 5, 9:
		case 8:
			if name != "" {
				nt = append(nt, pbStr(8, name))
			} else {
				nt = append(nt, f)
			}
		default:
			nt = append(nt, f)
		}
	}
	return append(nt, pbBytes(9, raw))
}

// f32to16: float32 → IEEE half с округлением; за пределами — бесконечность
func f32to16(f float32) uint16 {
	b := math.Float32bits(f)
	sign := uint16(b>>16) & 0x8000
	exp := int((b>>23)&0xff) - 127 + 15
	man := b & 0x7fffff
	if (b>>23)&0xff == 0xff {
		if man != 0 {
			return sign | 0x7e00
		}
		return sign | 0x7c00
	}
	switch {
	case exp <= 0:
		if exp < -10 {
			return sign
		}
		man |= 0x800000
		s := uint(14 - exp)
		h := uint16(man >> s)
		if man>>(s-1)&1 != 0 {
			h++
		}
		return sign | h
	case exp >= 31:
		return sign | 0x7c00
	}
	h := sign | uint16(exp<<10) | uint16(man>>13)
	if man&0x1000 != 0 {
		h++
	}
	return h
}

func f16to32(h uint16) float32 {
	sign := uint32(h&0x8000) << 16
	exp := uint32(h>>10) & 0x1f
	man := uint32(h & 0x3ff)
	switch {
	case exp == 0:
		v := float32(math.Ldexp(float64(man), -24))
		if sign != 0 {
			v = -v
		}
		return v
	case exp == 31:
		return math.Float32frombits(sign | 0x7f800000 | man<<13)
	}
	return math.Float32frombits(sign | (exp+112)<<23 | man<<13)
}
