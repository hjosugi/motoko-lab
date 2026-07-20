# Contribution Playbook

## Issue report template

```markdown
### Environment
- OS:
- moc version:
- core version:
- command/flags:

### Minimal reproduction
```motoko
// minimal source
```

### Expected

### Actual

### Regression range

### Additional evidence
```

## Before opening

- current master/changelogを確認
- duplicate issueを検索
- old `base` sampleが原因でないか確認
- deprecated flag/toolを使っていないか確認
- reproductionからprivate dataを除く

## PR workflow

```bash
git switch master
git pull --rebase
git switch -c yourname/short-topic
# edit + test
git add path/to/files
git commit -m "fix: concise behavior change"
git push -u origin yourname/short-topic
```

upstreamの最新contributing guideを常に優先します。

## Review response

- commentをactionable/not-actionable/questionに分類
- requested changeをcommit単位で小さくする
- behavior changeにはtestを追加
- disagreementはsource/test/specで説明
- force push後もreview contextを失わないようsummaryを残す

## Community behavior

maintainer trustはcode量だけでなく、reproduction quality、review responsiveness、release discipline、user empathyで積み上がります。
