local fooModule = import "./simple-import.libsonnet";

{
  bar: fooModule,
  baz: fooModule.foo,
}