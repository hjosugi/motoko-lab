# Lab 06 — Upgrade Migration

V1 recordへoptional license fieldを追加し、V2へupgradeする。次にbreaking changeを意図的に起こし、toolが検出することを確認する。

実例: [migration-chain/](migration-chain/README.md) — pinned moc 1.11.1の`--enhanced-migration`で、V1 → V2 (eager) → V3 (lazy) のmigration chainを組み、実replica上でlarge map・revoked variant・中断したrollout・fast-forward・downgrade拒否をrehearseします。互換性のない変更がcompile時にM0170で落ちること (gateが実際に効くこと) もCIで確認しています。
