(component
  (type $i (instance (export "attack" (func))))
  (import "wasi:filesystem/types@0.2.0" (instance $import (type $i)))
  (alias export $import "attack" (func $attack))
  (core func $lowered (canon lower (func $attack)))
  (core module $m
    (import "host" "attack" (func $attack))
    (func (export "run") call $attack))
  (core instance $host (export "attack" (func $lowered)))
  (core instance $guest (instantiate $m (with "host" (instance $host))))
  (func $run (canon lift (core func $guest "run")))
  (export "attack" (func $run)))
