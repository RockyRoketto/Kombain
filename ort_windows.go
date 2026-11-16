package main

// ONNX Runtime из Go без cgo: onnxruntime.dll грузится из папки движка, OrtGetApiBase → GetApi(24) даёт таблицу
// функций, вызовы идут syscall.SyscallN по номеру (номера из onnxruntime_c_api.h, версия API 24 = ORT 1.24).
// Считает DirectML: работает на любых видеокартах Windows (NVIDIA, AMD, Intel). DirectML.dll из папки движка
// грузится заранее по полному пути, тогда ORT берёт его, а не системный (тот бывает старым).
// Работает только в отдельном процессе (bgWorkerMain): падение драйвера не роняет программу, а выход процесса
// гарантированно отдаёт видеопамять.

import (
	"errors"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"
)

const ortAPIVersion = 24

// номера функций в struct OrtApi
const (
	ortGetErrorMessage                = 2
	ortCreateEnv                      = 3
	ortCreateSession                  = 7
	ortRun                            = 9
	ortCreateSessionOptions           = 10
	ortSetSessionExecutionMode        = 13
	ortDisableMemPattern              = 17
	ortSetSessionGraphOptimization    = 23
	ortSessionGetInputTypeInfo        = 33
	ortSessionGetInputName            = 36
	ortSessionGetOutputName           = 37
	ortCreateTensorWithDataAsOrtValue = 49
	ortGetTensorMutableData           = 51
	ortCastTypeInfoToTensorInfo       = 55
	ortGetTensorElementType           = 60
	ortGetDimensionsCount             = 61
	ortGetDimensions                  = 62
	ortGetTensorTypeAndShape          = 65
	ortCreateCpuMemoryInfo            = 69
	ortAllocatorFree                  = 76
	ortGetAllocatorWithDefaultOptions = 78
	ortReleaseEnv                     = 92
	ortReleaseStatus                  = 93
	ortReleaseMemoryInfo              = 94
	ortReleaseSession                 = 95
	ortReleaseValue                   = 96
	ortReleaseTypeInfo                = 98
	ortReleaseTensorTypeAndShapeInfo  = 99
	ortReleaseSessionOptions          = 100
)

type ortSession struct {
	api                         *[256]uintptr
	env, opts, sess, mem, alloc uintptr
	inName, outName             uintptr
	inType                      int32
	Adapter                     string // видеокарта, на которой считает DirectML
}

func (s *ortSession) call(i int, a ...uintptr) uintptr {
	r, _, _ := syscall.SyscallN(s.api[i], a...)
	return r
}

// ck превращает OrtStatus* в ошибку
func (s *ortSession) ck(st uintptr) error {
	if st == 0 {
		return nil
	}
	msg := cString(s.call(ortGetErrorMessage, st))
	s.call(ortReleaseStatus, st)
	return errors.New("onnxruntime: " + msg)
}

func cString(p uintptr) string {
	if p == 0 {
		return ""
	}
	var b []byte
	for {
		c := *(*byte)(unsafe.Pointer(p))
		if c == 0 {
			return string(b)
		}
		b = append(b, c)
		p++
	}
}

func ptr[T any](v *T) uintptr { return uintptr(unsafe.Pointer(v)) }

// ortOpen грузит модель на видеокарту с наибольшей собственной памятью (DirectML)
func ortOpen(engineDir, model string) (*ortSession, error) {
	syscall.LoadDLL(filepath.Join(engineDir, "DirectML.dll")) // нет — ORT возьмёт системный
	dll, err := syscall.LoadDLL(filepath.Join(engineDir, "onnxruntime.dll"))
	if err != nil {
		return nil, err
	}
	getBase, err := dll.FindProc("OrtGetApiBase")
	if err != nil {
		return nil, err
	}
	addDML, err := dll.FindProc("OrtSessionOptionsAppendExecutionProvider_DML")
	if err != nil {
		return nil, err
	}
	base, _, _ := getBase.Call()
	if base == 0 {
		return nil, errors.New("onnxruntime: no api base")
	}
	a, _, _ := syscall.SyscallN(*(*uintptr)(unsafe.Pointer(base)), ortAPIVersion)
	if a == 0 {
		return nil, errors.New("onnxruntime: api version not supported")
	}
	s := &ortSession{api: (*[256]uintptr)(unsafe.Pointer(a))}
	idx, name := dxgiBestAdapter()
	s.Adapter = name
	logid := []byte("kombain\x00")
	steps := []func() uintptr{
		func() uintptr { return s.call(ortCreateEnv, 3, ptr(&logid[0]), ptr(&s.env)) }, // 3 — только ошибки
		func() uintptr { return s.call(ortCreateSessionOptions, ptr(&s.opts)) },
		func() uintptr { return s.call(ortSetSessionGraphOptimization, s.opts, 99) },
		// DirectML требует: без шаблонов памяти и последовательно
		func() uintptr { return s.call(ortDisableMemPattern, s.opts) },
		func() uintptr { return s.call(ortSetSessionExecutionMode, s.opts, 0) },
		func() uintptr { r, _, _ := addDML.Call(s.opts, uintptr(idx)); return r },
	}
	for _, f := range steps {
		if err := s.ck(f()); err != nil {
			s.Close()
			return nil, err
		}
	}
	mp, err := syscall.UTF16PtrFromString(model)
	if err != nil {
		s.Close()
		return nil, err
	}
	if err := s.ck(s.call(ortCreateSession, s.env, ptr(mp), s.opts, ptr(&s.sess))); err != nil {
		s.Close()
		return nil, err
	}
	var ti, tin uintptr
	err = errors.Join(
		s.ck(s.call(ortGetAllocatorWithDefaultOptions, ptr(&s.alloc))),
		s.ck(s.call(ortSessionGetInputName, s.sess, 0, s.alloc, ptr(&s.inName))),
		s.ck(s.call(ortSessionGetOutputName, s.sess, 0, s.alloc, ptr(&s.outName))),
		s.ck(s.call(ortSessionGetInputTypeInfo, s.sess, 0, ptr(&ti))),
	)
	if err == nil {
		if err = s.ck(s.call(ortCastTypeInfoToTensorInfo, ti, ptr(&tin))); err == nil {
			err = s.ck(s.call(ortGetTensorElementType, tin, ptr(&s.inType)))
		}
	}
	if ti != 0 {
		s.call(ortReleaseTypeInfo, ti)
	}
	if err == nil {
		err = s.ck(s.call(ortCreateCpuMemoryInfo, 1, 0, ptr(&s.mem))) // OrtArenaAllocator, OrtMemTypeDefault
	}
	if err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

// Run: один вход NCHW float32 (во fp16 переводится здесь, если модель ждёт fp16), один выход float32
func (s *ortSession) Run(x []float32, shape []int64) ([]float32, []int64, error) {
	var data unsafe.Pointer
	var nbytes uintptr
	var h16 []uint16
	if s.inType == onnxF16 {
		h16 = make([]uint16, len(x))
		for i, f := range x {
			h16[i] = f32to16(f)
		}
		data, nbytes = unsafe.Pointer(&h16[0]), uintptr(len(h16)*2)
	} else {
		data, nbytes = unsafe.Pointer(&x[0]), uintptr(len(x)*4)
	}
	var inVal, outVal uintptr
	if err := s.ck(s.call(ortCreateTensorWithDataAsOrtValue, s.mem, uintptr(data), nbytes, ptr(&shape[0]), uintptr(len(shape)), uintptr(s.inType), ptr(&inVal))); err != nil {
		return nil, nil, err
	}
	defer s.call(ortReleaseValue, inVal)
	err := s.ck(s.call(ortRun, s.sess, 0, ptr(&s.inName), ptr(&inVal), 1, ptr(&s.outName), 1, ptr(&outVal)))
	runtime.KeepAlive(x)
	runtime.KeepAlive(h16)
	runtime.KeepAlive(shape)
	if err != nil {
		return nil, nil, err
	}
	defer s.call(ortReleaseValue, outVal)
	var info, p uintptr
	if err := s.ck(s.call(ortGetTensorTypeAndShape, outVal, ptr(&info))); err != nil {
		return nil, nil, err
	}
	var typ int32
	var nd uint64
	err = errors.Join(s.ck(s.call(ortGetTensorElementType, info, ptr(&typ))), s.ck(s.call(ortGetDimensionsCount, info, ptr(&nd))))
	dims := make([]int64, nd)
	if err == nil && nd > 0 {
		err = s.ck(s.call(ortGetDimensions, info, ptr(&dims[0]), uintptr(nd)))
	}
	s.call(ortReleaseTensorTypeAndShapeInfo, info)
	if err == nil {
		err = s.ck(s.call(ortGetTensorMutableData, outVal, ptr(&p)))
	}
	if err != nil {
		return nil, nil, err
	}
	n := 1
	for _, d := range dims {
		n *= int(d)
	}
	out := make([]float32, n)
	switch typ {
	case onnxF16:
		hs := unsafe.Slice((*uint16)(unsafe.Pointer(p)), n)
		for i := range out {
			out[i] = f16to32(hs[i])
		}
	case onnxFloat:
		copy(out, unsafe.Slice((*float32)(unsafe.Pointer(p)), n))
	default:
		return nil, nil, errors.New("onnxruntime: unexpected output type")
	}
	return out, dims, nil
}

func (s *ortSession) Close() {
	if s.alloc != 0 {
		if s.inName != 0 {
			s.call(ortAllocatorFree, s.alloc, s.inName)
		}
		if s.outName != 0 {
			s.call(ortAllocatorFree, s.alloc, s.outName)
		}
	}
	if s.mem != 0 {
		s.call(ortReleaseMemoryInfo, s.mem)
	}
	if s.sess != 0 {
		s.call(ortReleaseSession, s.sess)
	}
	if s.opts != 0 {
		s.call(ortReleaseSessionOptions, s.opts)
	}
	if s.env != 0 {
		s.call(ortReleaseEnv, s.env)
	}
	*s = ortSession{api: s.api}
}

// dxgiBestAdapter: номер видеокарты для DirectML (порядок DXGI, как его считает ORT) — у которой больше всего
// собственной видеопамяти. На ноутбуках с двумя картами это дискретная, а не встроенная. Не вышло — 0.
func dxgiBestAdapter() (int, string) {
	dxgi, err := syscall.LoadDLL("dxgi.dll")
	if err != nil {
		return 0, ""
	}
	create, err := dxgi.FindProc("CreateDXGIFactory1")
	if err != nil {
		return 0, ""
	}
	iid := syscall.GUID{Data1: 0x770aae78, Data2: 0xf26f, Data3: 0x4dba, Data4: [8]byte{0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87}} // IDXGIFactory1
	var factory uintptr
	if r, _, _ := create.Call(uintptr(unsafe.Pointer(&iid)), ptr(&factory)); r != 0 || factory == 0 {
		return 0, ""
	}
	vt := func(obj uintptr, i int) uintptr {
		return *(*uintptr)(unsafe.Pointer(*(*uintptr)(unsafe.Pointer(obj)) + uintptr(i)*unsafe.Sizeof(uintptr(0))))
	}
	release := func(obj uintptr) { syscall.SyscallN(vt(obj, 2), obj) }
	defer release(factory)
	// DXGI_ADAPTER_DESC1
	type desc1 struct {
		Description                  [128]uint16
		VendorID, DeviceID, SubSysID uint32
		Revision                     uint32
		DedicatedVideo, DedicatedSys uintptr
		SharedSys                    uintptr
		LUID                         [8]byte
		Flags                        uint32
		_                            uint32
	}
	best, bestMem, bestName := 0, uintptr(0), ""
	for i := 0; i < 16; i++ {
		var ad uintptr
		if r, _, _ := syscall.SyscallN(vt(factory, 12), factory, uintptr(i), ptr(&ad)); r != 0 || ad == 0 { // EnumAdapters1
			break
		}
		var d desc1
		r, _, _ := syscall.SyscallN(vt(ad, 10), ad, ptr(&d)) // GetDesc1
		release(ad)
		if r != 0 || d.Flags&2 != 0 { // DXGI_ADAPTER_FLAG_SOFTWARE
			continue
		}
		if d.DedicatedVideo > bestMem {
			best, bestMem, bestName = i, d.DedicatedVideo, syscall.UTF16ToString(d.Description[:])
		}
	}
	return best, bestName
}
