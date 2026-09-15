(component
  (core module $m (memory 1 4096) (func (export "run")))
  (core instance $first (instantiate $m))
  (core instance $second (instantiate $m))
  (func $run (canon lift (core func $second "run")))
  (instance $command (export "run" (func $run)))
  (export "wasi:cli/run@0.2.11" (instance $command)))
