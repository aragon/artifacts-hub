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

# Ingest every upstream address source, enrich on-chain, write addresses/<chainId>.json
[group('ingest')]
sync *args:
    cd scripts && deno task sync {{ args }}

# Read one chain via ProtocolFactory.getDeployment() (usage: just read-network <chainId> [<rpc> <pf>])
[group('ingest')]
read-network *args:
    cd scripts && deno task read-network {{ args }}
