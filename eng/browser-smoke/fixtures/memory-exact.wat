(component
  (core module $m (memory 1 32768) (func (export "run")))
  (core instance $guest (instantiate $m))
  (func $run (canon lift (core func $guest "run")))
  (instance $command (export "run" (func $run)))
  (export "wasi:cli/run@0.2.11" (instance $command)))
