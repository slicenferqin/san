为 Context Steady 受控压力 Benchmark 仅揭示一个有序证据分片。第 1 步不传 previousProof；之后每一步必须传入前一成功步骤返回的精确 proof。按顺序处理所有步骤，并把每个 RECORD 对象持久化到 evidence.ndjson；禁止批量领取、跳步或乱序获取未来证据。
