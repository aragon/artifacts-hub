default: help

# Show available commands
help:
    @just --list --unsorted

# Validate every addresses/*.json against the Zod schema
[group('audit')]
validate:
    cd scripts && deno task validate

# Run the scripts' unit tests
[group('audit')]
test:
    cd scripts && deno task test

# Report per-network coverage grouped by status + per-section gap summary
[group('audit')]
coverage *args:
    cd scripts && deno task coverage {{ args }}

# Ingest a chain from its ProtocolFactory (usage: just ingest <chainId> <rpc> <pf> [network])
[group('ingest')]
ingest *args:
    cd scripts && deno task ingest {{ args }}

# Import a PluginArtifact envelope (or a directory of them) into addresses/<chainId>.json
[group('ingest')]
import-plugin *args:
    cd scripts && INVOCATION_DIR={{ invocation_directory() }} deno task import-plugin {{ args }}

# Read all on-chain versions of a plugin's PluginRepo and merge them into addresses/<chainId>.json
# (usage: just refresh-plugin <slug> <chainId> <rpcUrl>)
[group('ingest')]
refresh-plugin *args:
    cd scripts && INVOCATION_DIR={{ invocation_directory() }} deno task refresh-plugin {{ args }}

# Regenerate abi/<component>/index.ts + abi/index.ts from the JSON files present in abi/
[group('abi')]
generate-abi:
    cd scripts && deno task generate-abi
