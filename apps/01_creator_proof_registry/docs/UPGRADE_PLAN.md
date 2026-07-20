# Upgrade Plan

V1 uses additive records and stable `Map` values. Before any field rename/type change:

1. deploy old version
2. create commitments, active/revoked records, parent chain
3. export counts and hashes
4. upgrade staging
5. compare all records and indexes
6. run duplicate/revoke/new-record smoke tests
7. verify generated Candid compatibility

Future algorithm agility should add a new digest type through a migration, not reinterpret existing bytes.
