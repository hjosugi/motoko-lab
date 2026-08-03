/// Minimal client for the Internet Computer LLM canister.
///
/// This mirrors the wire types of `mo:llm` (the `dfinity/llm` Motoko package)
/// so a canister can call the real thing without taking the dependency. Two
/// reasons to keep a local copy in this kit:
///
///   * `mo:llm` is fetched from the Mops registry, which lives on the Internet
///     Computer. Any network that blocks `icp-api.io` cannot install it, and
///     the whole app then fails to build. This module has no dependencies
///     beyond `mo:core` and the Motoko prims.
///   * Having the types in-tree makes the `llm_shim` canister in this app a
///     drop-in stand-in: the same Candid interface, served locally, with no
///     Ollama process and no gateway API key.
///
/// Resolution order for the callee, matching `mo:llm`:
///   1. an explicit override set by the operator (used to point at the shim),
///   2. the `PUBLIC_CANISTER_ID:llm` environment variable that `icp deploy`
///      injects when an `llm` canister is part of the project,
///   3. the mainnet LLM canister.
import Env "Env";

module {

  /// Mainnet principal of the LLM canister.
  public let MAINNET : Text = "w36hm-eqaaa-aaaal-qr76a-cai";

  /// Models the LLM canister serves without charging cycles. Anything else is
  /// treated as paid and needs `CYCLES_PER_CHAT` attached, which means the
  /// calling canister must actually hold them or the call traps.
  let FREE_MODELS : [Text] = ["llama3.1:8b", "qwen3:32b"];
  let CYCLES_PER_CHAT : Nat = 100_000_000_000;

  public type ToolCallArgument = { name : Text; value : Text };
  public type FunctionCall = { name : Text; arguments : [ToolCallArgument] };
  public type ToolCall = { id : Text; function : FunctionCall };

  public type AssistantMessage = {
    content : ?Text;
    tool_calls : [ToolCall];
  };

  public type ChatMessage = {
    #user : { content : Text };
    #system_ : { content : Text };
    #assistant : AssistantMessage;
    #tool : { content : Text; tool_call_id : Text };
  };

  public type Property = {
    type_ : Text;
    name : Text;
    description : ?Text;
    enum_ : ?[Text];
  };
  public type Parameters = {
    type_ : Text;
    properties : ?[Property];
    required : ?[Text];
  };
  public type Function = {
    name : Text;
    description : ?Text;
    parameters : ?Parameters;
  };
  public type Tool = { #function : Function };

  public type Request = {
    model : Text;
    messages : [ChatMessage];
    tools : ?[Tool];
  };

  public type Response = { message : AssistantMessage };

  public type LlmCanister = actor {
    v1_chat : (Request) -> async Response;
  };

  public func isFreeModel(model : Text) : Bool {
    for (free in FREE_MODELS.vals()) { if (free == model) return true };
    false;
  };

  /// Principal this canister will call, given an optional operator override.
  public func resolve<system>(override_ : ?Text) : Text {
    switch (override_) {
      case (?id) id;
      case null {
        switch (Env.canisterId<system>("llm")) {
          case (?id) id;
          case null MAINNET;
        };
      };
    };
  };

  public func canister<system>(override_ : ?Text) : LlmCanister {
    actor (resolve<system>(override_)) : LlmCanister;
  };

  /// Single-turn prompt. Paid models get cycles attached; free models do not,
  /// so a canister with an empty cycle balance can still call `llama3.1:8b`.
  public func prompt<system>(override_ : ?Text, model : Text, text : Text) : async Text {
    let request : Request = {
      model;
      messages = [#user { content = text }];
      tools = null;
    };
    let cycles = if (isFreeModel(model)) 0 else CYCLES_PER_CHAT;
    let response = await (with cycles = cycles) canister<system>(override_).v1_chat(request);
    switch (response.message.content) {
      case (?content) content;
      case null "";
    };
  };
};
