(component
  (type $clock-type (instance
    (export "now" (func (result u64)))
    (export "resolution" (func (result u64)))))
  (import "wasi:clocks/monotonic-clock@0.2.11" (instance $clock (type $clock-type)))
  (alias export $clock "now" (func $now))
  (alias export $clock "resolution" (func $resolution))
  (core func $lower-now (canon lower (func $now)))
  (core func $lower-resolution (canon lower (func $resolution)))
  (core module $m
    (import "clock" "now" (func $now (result i64)))
    (import "clock" "resolution" (func $resolution (result i64)))
    (func (export "run") (result i32) (local $first i64)
      call $now local.set $first
      call $now local.get $first i64.lt_u
      if unreachable end
      call $resolution i64.eqz
      if unreachable end
      i32.const 0))
  (core instance $clock-core
    (export "now" (func $lower-now))
    (export "resolution" (func $lower-resolution)))
  (core instance $guest (instantiate $m (with "clock" (instance $clock-core))))
  (func $run (result (result)) (canon lift (core func $guest "run")))
  (instance $command (export "run" (func $run)))
  (export "wasi:cli/run@0.2.11" (instance $command)))
