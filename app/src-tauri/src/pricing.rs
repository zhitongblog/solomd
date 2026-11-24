//! v4.0 — provider pricing lookup for cost estimation.
//!
//! Turns the `usage` numbers we collect off each agent run into a dollar
//! cost estimate written to `meta.json.cost_usd_estimate` and rendered in
//! the trace footer / Recent Runs list. Rates are USD per 1M tokens.
//!
//! Anthropic, OpenAI, Gemini and DeepSeek rates come from the `llm-prices`
//! crate: a dated, source-cited table of each provider's list prices that
//! resolves dated snapshots (`claude-sonnet-4-6-20251205`), `-latest`
//! aliases and `models/` prefixes to the right row. It is compiled in, so
//! there is still no live pricing fetch. Bumping the crate picks up new
//! models and price changes.
//!
//! Providers `llm-prices` does not cover (Qwen, GLM, Kimi, Doubao,
//! MiniMax) use the hand-maintained table below, matched with a *prefix*
//! check so that dated variants snap to the unsuffixed entry. If nothing
//! matches, we return `(0.0, 0.0)` and the cost estimate stays at zero,
//! which renders as `$0.0000` in the UI.
//!
//! Local providers (Ollama) and aggregators where the per-call cost
//! depends on the routed model (OpenRouter, SiliconFlow, Groq, Mistral
//! mixed pool, xAI rate-limited tiers) intentionally fall through to 0.

/// Returns `(input_per_1m_usd, output_per_1m_usd)` for the given
/// provider + model. Falls back to `(0.0, 0.0)` when unknown.
pub fn rates_for(provider: &str, model: &str) -> (f64, f64) {
    if let Some(rates) = list_price_rates(provider, model) {
        return rates;
    }
    let model_lc = model.to_ascii_lowercase();
    let table = price_table();
    for (p, m, r_in, r_out) in table {
        if *p == provider && model_lc.starts_with(*m) {
            return (*r_in, *r_out);
        }
    }
    (0.0, 0.0)
}

/// List prices from `llm-prices` for the first-party APIs it covers.
/// `None` for every other provider, or when the table has no input and
/// output price for the model (embeddings, unknown ids).
fn list_price_rates(provider: &str, model: &str) -> Option<(f64, f64)> {
    let price = match provider {
        "anthropic" | "openai" | "gemini" | "deepseek" => {
            llm_prices::lookup_provider(provider, model)?
        }
        _ => return None,
    };
    Some((price.input?, price.output?))
}

/// Compute a USD cost estimate from token counts + a model id. Returns 0
/// when the (provider, model) pair has no entry in the price table.
pub fn estimate_cost_usd(provider: &str, model: &str, tokens_in: u64, tokens_out: u64) -> f64 {
    let (rin, rout) = rates_for(provider, model);
    if rin == 0.0 && rout == 0.0 {
        return 0.0;
    }
    ((tokens_in as f64) * rin + (tokens_out as f64) * rout) / 1_000_000.0
}

/// Provider, model-prefix, $/1M input, $/1M output, for providers that
/// `llm-prices` does not cover.
///
/// Order matters only when two prefixes for the same provider could both
/// match — list the more specific one first. Today every entry is unique
/// so the order is alphabetical for readability.
fn price_table() -> &'static [(&'static str, &'static str, f64, f64)] {
    &[
        // OpenAI, Anthropic, Gemini and DeepSeek: see `list_price_rates`.
        // ---- Qwen -------------------------------------------------------
        ("qwen", "qwen-max", 2.0, 6.0),
        // ---- GLM --------------------------------------------------------
        ("glm", "glm-4-plus", 0.7, 1.4),
        // ---- Kimi (Moonshot) --------------------------------------------
        ("kimi", "moonshot-v1", 12.0, 12.0),
        // ---- Doubao (Volcengine) ----------------------------------------
        ("doubao", "doubao-pro", 0.8, 2.0),
        ("volcengine", "doubao-pro", 0.8, 2.0),
        // ---- MiniMax ----------------------------------------------------
        // Flash standard direct API rate; keep this before the M3 prefix.
        // https://platform.minimax.io/docs/pricing/overview#models/text
        ("minimax", "minimax-m3.1-flash", 0.15, 0.60),
        // M3 at the rate OpenRouter publishes (the only public source we could
        // verify, 2026-09-25); the PR proposed 0.6/2.4.
        ("minimax", "minimax-m3", 0.3, 1.2),
        ("minimax", "minimax-m2.7", 0.3, 1.2),
        // ---- Aggregators / local: 0 default; per-model best effort can
        // ----                      be added over time.
        // siliconflow / openrouter / mistral / groq / xai / ollama → 0
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimax_flash_rate_precedes_m3_prefix() {
        for model in ["MiniMax-M3.1-Flash", "MINIMAX-M3.1-FLASH-20261020"] {
            assert_eq!(rates_for("minimax", model), (0.15, 0.60));
            let cost = estimate_cost_usd("minimax", model, 1_000, 500);
            assert!((cost - 0.00045).abs() < 1e-12, "got {cost}");
        }
        assert_eq!(
            rates_for("openrouter", "minimax/minimax-m3.1-flash:free"),
            (0.0, 0.0)
        );
    }

    #[test]
    fn minimax_rates_and_cost_estimates() {
        assert_eq!(rates_for("minimax", "MiniMax-M3"), (0.3, 1.2));
        let cost = estimate_cost_usd("minimax", "MiniMax-M3", 1_000, 500);
        assert!((cost - 0.0009).abs() < 1e-12, "got {cost}");
        assert_eq!(rates_for("minimax", "MiniMax-M2.7"), (0.3, 1.2));
        let cost = estimate_cost_usd("minimax", "MiniMax-M2.7", 1_000, 500);
        assert!((cost - 0.0009).abs() < 1e-12, "got {cost}");
    }

    #[test]
    fn minimax_preserves_lookup_and_zero_cost_fallbacks() {
        assert_eq!(rates_for("minimax", "MINIMAX-M3-20260901"), (0.3, 1.2));
        assert_eq!(rates_for("minimax", "MINIMAX-M2.7-20260901"), (0.3, 1.2));
        assert_eq!(rates_for("minimax", "unknown"), (0.0, 0.0));
        assert_eq!(estimate_cost_usd("minimax", "unknown", 1_000, 500), 0.0);
        assert_eq!(rates_for("unknown", "MiniMax-M3"), (0.0, 0.0));
        assert_eq!(estimate_cost_usd("minimax", "MiniMax-M3", 0, 0), 0.0);
    }

    #[test]
    fn exact_match_returns_published_rate() {
        let (i, o) = rates_for("openai", "gpt-4o");
        assert_eq!(i, 2.5);
        assert_eq!(o, 10.0);
    }

    #[test]
    fn prefix_match_picks_up_dated_variant() {
        // claude-sonnet-4-6-20251205 should match the claude-sonnet-4-6 row.
        let (i, o) = rates_for("anthropic", "claude-sonnet-4-6-20251205");
        assert_eq!(i, 3.0);
        assert_eq!(o, 15.0);
        // gpt-4o-2024-08-06 should match gpt-4o.
        let (i2, o2) = rates_for("openai", "gpt-4o-2024-08-06");
        assert_eq!(i2, 2.5);
        assert_eq!(o2, 10.0);
    }

    #[test]
    fn case_insensitive_model_match() {
        let (i, _o) = rates_for("anthropic", "Claude-Haiku-4-5");
        assert_eq!(i, 1.0);
    }

    #[test]
    fn list_prices_match_provider_pricing_pages() {
        // The old hand table had Opus 4.7 at 15/75, Haiku 4.5 at 0.8/4 and
        // Gemini 2.5 Flash at 0.075/0.3.
        assert_eq!(rates_for("anthropic", "claude-opus-4-7"), (5.0, 25.0));
        assert_eq!(rates_for("anthropic", "claude-haiku-4-5"), (1.0, 5.0));
        assert_eq!(rates_for("gemini", "gemini-2.5-flash"), (0.3, 2.5));
        // 10k in + 2k out on Opus 4.7: 0.05 + 0.05 = $0.10 (was $0.30).
        let c = estimate_cost_usd("anthropic", "claude-opus-4-7", 10_000, 2_000);
        assert!((c - 0.10).abs() < 1e-9, "got {c}");
    }

    #[test]
    fn current_models_are_priced_instead_of_zero() {
        for (provider, model) in [
            ("openai", "gpt-5.2"),
            ("openai", "gpt-5-mini"),
            ("anthropic", "claude-fable-5"),
            ("gemini", "gemini-3-flash-preview"),
            ("gemini", "models/gemini-3.1-pro-preview"),
        ] {
            let (i, o) = rates_for(provider, model);
            assert!(
                i > 0.0 && o > 0.0,
                "{provider}/{model} priced at ({i}, {o})"
            );
        }
    }

    #[test]
    fn embedding_rows_without_output_price_stay_zero() {
        assert_eq!(rates_for("openai", "text-embedding-3-small"), (0.0, 0.0));
    }

    #[test]
    fn mini_prefix_does_not_swallow_full_4o() {
        // Make sure gpt-4o-mini stays distinct from gpt-4o.
        let (i_mini, _) = rates_for("openai", "gpt-4o-mini");
        let (i_full, _) = rates_for("openai", "gpt-4o");
        assert_eq!(i_mini, 0.15);
        assert_eq!(i_full, 2.5);
    }

    #[test]
    fn unknown_provider_returns_zero() {
        let (i, o) = rates_for("siliconflow", "qwen-2.5-72b");
        assert_eq!((i, o), (0.0, 0.0));
        let (i2, o2) = rates_for("ollama", "llama3.2");
        assert_eq!((i2, o2), (0.0, 0.0));
        let (i3, o3) = rates_for("openrouter", "anthropic/claude-sonnet");
        assert_eq!((i3, o3), (0.0, 0.0));
    }

    #[test]
    fn unknown_model_for_known_provider_returns_zero() {
        // Provider known but model not in the table.
        let (i, o) = rates_for("openai", "o1-preview");
        assert_eq!((i, o), (0.0, 0.0));
    }

    #[test]
    fn estimate_cost_basic_arithmetic() {
        // gpt-4o: 2.5 / 10.0 per 1M.  1M in + 1M out = $12.5
        let c = estimate_cost_usd("openai", "gpt-4o", 1_000_000, 1_000_000);
        assert!((c - 12.5).abs() < 1e-9, "got {c}");
        // 1000 in + 500 out: 2.5*0.001 + 10*0.0005 = 0.0025 + 0.005 = 0.0075
        let c2 = estimate_cost_usd("openai", "gpt-4o", 1000, 500);
        assert!((c2 - 0.0075).abs() < 1e-9, "got {c2}");
    }

    #[test]
    fn estimate_cost_unknown_returns_zero() {
        assert_eq!(estimate_cost_usd("ollama", "llama3", 5_000, 10_000), 0.0);
        assert_eq!(estimate_cost_usd("zzz", "no-such", 1, 1), 0.0);
    }
}
