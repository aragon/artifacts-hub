default: help

# Show available commands
help:
    @just --list --unsorted

# Validate every addresses/*.json against the Zod schema
validate:
    cd scripts && deno task validate

# Read a chain's state via ProtocolFactory.getDeployment() and write addresses/<chainId>.json
# Usage: just read-network <chainId>                         (looks up RPC + PF from just-foundry env)
#        just read-network <chainId> <rpcUrl> <pfAddress>    (explicit)
read-network *args:
    cd scripts && deno task read-network {{ args }}
