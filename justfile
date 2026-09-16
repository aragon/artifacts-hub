default: help

# Show available commands
help:
    @just --list --unsorted

# Validate every addresses/*.json against the Zod schema
[group('audit')]
validate:
    cd scripts && deno task validate

# Report per-network coverage grouped by status + per-section gap summary
[group('audit')]
coverage *args:
    cd scripts && deno task coverage {{ args }}

# Ingest a chain from its ProtocolFactory (usage: just ingest <chainId> <rpc> <pf> [network])
[group('ingest')]
ingest *args:
    cd scripts && deno task ingest {{ args }}
