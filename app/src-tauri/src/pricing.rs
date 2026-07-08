//! v4.0 — provider pricing lookup for cost estimation.
//!
//! Hard-coded per-provider published rates (USD per 1M tokens) used to
//! turn the `usage` numbers we collect off each agent run into a dollar
//! cost estimate written to `meta.json.cost_usd_estimate` and rendered in
//! the trace footer / Recent Runs list.
//!
//! These are launch-day defaults — no live pricing fetch. We match the
//! incoming `model` string with a *prefix* check so that dated variants
//! (e.g. `claude-sonnet-4-6-20251205`) snap to the unsuffixed entry. If
//! nothing matches, we return `(0.0, 0.0)` and the cost estimate stays
//! at zero, which renders as `$0.0000` in the UI — accurate and honest
//! rather than wrong.
//!
//! Local providers (Ollama) and aggregators where the per-call cost
//! depends on the routed model (OpenRouter, SiliconFlow, Groq, Mistral
//! mixed pool, xAI rate-limited tiers) intentionally fall through to 0.

/// Returns `(input_per_1m_usd, output_per_1m_usd)` for the given
/// provider + model. Falls back to `(0.0, 0.0)` when unknown.
pub fn rates_for(provider: &str, model: &str) -> (f64, f64) {
    let model_lc = model.to_ascii_lowercase();
    let table = price_table();
    for (p, m, r_in, r_out) in table {
        if *p == provider && model_lc.starts_with(*m) {
            return (*r_in, *r_out);
        }
    }
    (0.0, 0.0)
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

/// Provider, model-prefix, $/1M input, $/1M output.
///
/// Order matters only when two prefixes for the same provider could both
/// match — list the more specific one first. Today every entry is unique
/// so the order is alphabetical for readability.
fn price_table() -> &'static [(&'static str, &'static str, f64, f64)] {
    &[
        // ---- OpenAI -----------------------------------------------------
        ("openai", "gpt-4o-mini", 0.15, 0.6),
        ("openai", "gpt-4o", 2.5, 10.0),
        // ---- Anthropic --------------------------------------------------
        ("anthropic", "claude-sonnet-4-6", 3.0, 15.0),
        ("anthropic", "claude-haiku-4-5", 0.8, 4.0),
        ("anthropic", "claude-opus-4-7", 15.0, 75.0),
        // ---- Gemini (OpenAI-compat or Google native) --------------------
        ("gemini", "gemini-2.5-flash", 0.075, 0.3),
        ("gemini", "gemini-1.5-pro", 1.25, 5.0),
        // ---- DeepSeek ---------------------------------------------------
        ("deepseek", "deepseek-chat", 0.14, 0.28),
        // ---- Qwen -------------------------------------------------------
        ("qwen", "qwen-max", 2.0, 6.0),
        // ---- GLM --------------------------------------------------------
        ("glm", "glm-4-plus", 0.7, 1.4),
        // ---- Kimi (Moonshot) --------------------------------------------
        ("kimi", "moonshot-v1", 12.0, 12.0),
        // ---- Doubao (Volcengine) ----------------------------------------
        ("doubao", "doubao-pro", 0.8, 2.0),
        ("volcengine", "doubao-pro", 0.8, 2.0),
        // ---- Aggregators / local: 0 default; per-model best effort can
        // ----                      be added over time.
        // siliconflow / openrouter / mistral / groq / xai / ollama → 0
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(i, 0.8);
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
