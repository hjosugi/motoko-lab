# PRD: Creator Provenance Network

## Problem

AI-assisted productionで、creator、client、marketplace、reviewerが制作過程とlicenseをportableに検証できない。

## Primary users

- creator
- studio admin
- client/legal reviewer
- marketplace verifier
- dispute reviewer

## MVP user story

1. creator signs in
2. local tool hashes artifact and manifest
3. creator commits before publishing
4. creator reveals metadata
5. public verifier checks hash and active status
6. creator exports evidence bundle

## MVP requirements

- anonymous write rejection
- commit-reveal
- 32-byte cryptographic hash fields
- parent links
- AI disclosure
- revocation
- pagination
- CLI verifier
- portable JSON export
- clear non-authorship disclaimer

## Post-MVP

- certified query
- C2PA bridge
- organization VC
- delegated project keys
- license marketplace
- batch Merkle anchoring
- private evidence vault
- dispute workflow

## Success metrics

- 70% onboarding completion
- first proof under 5 min
- >2 third-party verification views per active creator/month
- 30-day creator retention >35%
- first 10 paid studios
- zero unbounded input incidents

## Out of scope

- AI detector
- copyright court
- raw source hosting by default
- token speculation
