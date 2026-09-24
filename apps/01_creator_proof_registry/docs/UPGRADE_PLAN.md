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

Disputes (#8) are additive stable state: new maps, one id counter, and a second label (`dispute`) in the certified tree beside `record`. The replica suite checks that a dispute exported after an upgrade verifies to the same certified head, that a claimant suspension survives, and that dispute ids continue. A future change to the event layout gets a new domain string (`icp-creator-proof:dispute-event:v2`) and applies to new events only; existing logs are never re-hashed, because their heads have already been certified and exported.
