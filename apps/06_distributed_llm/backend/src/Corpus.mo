/// Training corpus baked into the canister.
///
/// The model in `Lm.mo` is fitted from this text at initialisation. Keeping the
/// corpus in the canister (rather than uploading it) makes every replica derive
/// bit-identical counts, which is what lets independent nodes agree on a token.
module {

  /// Domain text about the Internet Computer, Motoko and distributed inference.
  /// Written for this kit, so there is no third-party licensing to track.
  public let text : Text = "
a canister is a smart contract that runs as a webassembly module on the internet computer .
a canister holds state and code together and the state survives an upgrade .
motoko is the native language of the internet computer and it compiles to webassembly .
motoko models a canister as an actor and every public method of an actor is asynchronous .
an actor never shares memory with another actor so the only way to move data is a message .
a message between two canisters is called an inter canister call and it costs latency .
inter canister call latency on the internet computer is bounded by the consensus round .
consensus requires that every replica in a subnet computes the same result from the same input .
determinism is therefore not a preference on the internet computer it is a requirement .
floating point arithmetic is a classic source of divergence between replicas .
integer arithmetic is deterministic so a model that must run on chain should use integer arithmetic .
a language model predicts the next token from the tokens that came before it .
an autoregressive model produces one token per forward pass and each pass depends on the previous token .
the sequential dependency of an autoregressive model is the reason that generation is slow .
a diffusion language model starts from masked positions and unmasks several positions in parallel .
a masked diffusion model can fill many positions in one step so it needs fewer sequential steps .
a diffusion model trades sequential steps for extra work per step .
speculative decoding uses a small draft model to propose tokens and a large target model to verify them .
the target model verifies a whole block of draft tokens in a single pass .
if the draft token matches the target token then the draft token is accepted .
if the draft token does not match then every later draft token is discarded .
speculative decoding is lossless because the accepted output is exactly the output of the target model .
the speedup of speculative decoding depends on the acceptance rate of the draft model .
a draft model that agrees with the target model often will give a high acceptance rate .
a hybrid decoder uses a diffusion draft and an autoregressive verifier .
the diffusion draft proposes a block of tokens in parallel and the verifier keeps the longest correct prefix .
this hybrid removes the sequential feedback loop from the draft stage .
distributed inference splits one model across several machines that talk over a network .
pipeline parallelism assigns a contiguous group of layers to each machine .
tensor parallelism splits a single layer across machines and needs a collective operation per layer .
vocabulary parallelism splits the output projection so each machine scores part of the vocabulary .
in vocabulary parallelism each worker returns only its local maximum so the message stays small .
the activation that moves between two pipeline stages is a dense vector and it dominates the traffic .
on a slow link the transport of activations can cost more time than the arithmetic .
quantizing an activation to eight bits cuts the transported bytes by a factor of four .
quantizing an activation can change the argmax of a step so the output is not guaranteed to be identical .
a lossless method keeps the output identical while a lossy method trades accuracy for bandwidth .
a verifier can repair a lossy draft because verification compares against the exact target model .
therefore a lossy transport in the draft stage is safe when an exact verifier follows it .
this is the reason that quantization and speculative decoding compose well .
a subnet of the internet computer replicates every canister on many nodes .
replication multiplies the compute cost so replicating a large model is expensive .
sharding a model across canisters splits the memory but does not remove the replication factor .
the llm canister on the internet computer forwards a prompt to a stateless worker outside consensus .
a stateless worker can run a large model without forcing every replica to run it .
the trade off is that the response of the worker is not verified by consensus .
a canister can still record the prompt and the response so the trace is auditable .
an auditable trace is weaker than a verified computation but it is stronger than nothing .
the cost of a canister call is measured in cycles and cycles are burned by execution and by memory .
an upgrade of a canister keeps stable variables and discards everything else .
a persistent actor in modern motoko keeps every top level variable across an upgrade .
a query call is fast because it skips consensus and it cannot change state .
an update call goes through consensus and it can change state .
a query call cannot make an inter canister call to another canister .
therefore an orchestrator that fans out to workers must run as an update call .
the round trip of an update call is the unit of latency in a distributed canister design .
reducing the number of sequential rounds matters more than reducing the work inside a round .
speculative decoding reduces the number of sequential rounds and that is why it helps here .
a block of eight draft tokens can collapse eight rounds into one verification round .
the acceptance rate decides how many of those eight tokens survive .
measuring the acceptance rate on real prompts is the only honest way to report a speedup .
a benchmark that reports tokens per second without an acceptance rate is not reproducible .
reproducibility matters because a distributed system is judged by its worst case .
the worst case of a speculative decoder is that no draft token is accepted .
in that worst case the decoder still produces the correct token from the verifier .
so the method is safe and only the speedup is at risk .
"
}
