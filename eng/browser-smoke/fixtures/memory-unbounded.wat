(component (core module $m (memory 1) (func (export "run"))) (core instance $guest (instantiate $m)) (func $run (canon lift (core func $guest "run"))) (export "attack" (func $run)))
