//go:build !windows

package main

import "errors"

// ONNX Runtime с DirectML есть только в Windows
type ortSession struct{ Adapter string }

func ortOpen(engineDir, model string) (*ortSession, error) {
	return nil, errors.New("onnxruntime: windows only")
}

func (s *ortSession) Run(x []float32, shape []int64) ([]float32, []int64, error) {
	return nil, nil, errors.New("onnxruntime: windows only")
}

func (s *ortSession) Close() {}
