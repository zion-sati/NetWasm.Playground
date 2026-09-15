(component
  (type $i (instance (export "subscribe-duration" (func (param "duration" u64)))))
  (import "wasi:clocks/monotonic-clock@0.2.11" (instance $import (type $i)))
  (alias export $import "subscribe-duration" (func $attack))
  (core func $lowered (canon lower (func $attack)))
  (core module $m
    (import "host" "attack" (func $attack (param i64)))
    (func (export "run") (result i32) i64.const 1000000000 call $attack i32.const 0))
  (core instance $host (export "attack" (func $lowered)))
  (core instance $guest (instantiate $m (with "host" (instance $host))))
  (func $run (result (result)) (canon lift (core func $guest "run")))
  (instance $command (export "run" (func $run)))
  (export "wasi:cli/run@0.2.11" (instance $command)))
