use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// Capture the actual reqwest request, including its serialized body. No real
// provider credentials or network endpoints are used by these tests.
async fn capture_turn(
    model: &str,
    history: &[Value],
    tools: &Value,
    response: &str,
) -> (Value, TurnOutcome) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let response = response.to_string();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let (body_start, body_len) = loop {
            let mut buf = [0u8; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buf[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
                assert!(!headers.to_ascii_lowercase().contains("authorization:"));
                let len = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                break (end + 4, len);
            }
        };
        while bytes.len() < body_start + body_len {
            let mut buf = [0u8; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buf[..n]);
        }
        let body: Value =
            serde_json::from_slice(&bytes[body_start..body_start + body_len]).unwrap();
        let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response);
        socket.write_all(reply.as_bytes()).await.unwrap();
        (body, ())
    });
    let req: ChatRequest = serde_json::from_value(serde_json::json!({
        "provider": "minimax", "api_format": "openai", "model": model,
        "messages": [], "base_url": format!("http://{addr}/v1")
    }))
    .unwrap();
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        openai_one_turn(
            None,
            "minimax-test",
            &req,
            "",
            history,
            tools,
            Arc::new(AtomicBool::new(false)),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    (server.await.unwrap().0, outcome)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn minimax_http_preserves_models_history_and_default_thinking() {
    let history = serde_json::json!([
        {"role":"system", "content":"You edit notes."},
        {"role":"user", "content":[
            {"type":"text", "text":"Describe this image"},
            {"type":"image_url", "image_url":{"url":"https://example.invalid/image.png", "detail":"high"}}
        ]},
        {"role":"assistant", "content":"<think>Keep this</think>", "reasoning_content":"Prior reasoning", "tool_calls":[
            {"id":"call_1", "type":"function", "function":{"name":"read_note", "arguments":"{}"}}
        ]},
        {"role":"tool", "tool_call_id":"call_1", "content":"Note content"}
    ]);
    let tools = serde_json::json!([{"type":"function", "function":{"name":"read_note", "parameters":{"type":"object", "properties":{}}}}]);
    for model in [
        "MiniMax-M3.1-Flash",
        "MiniMax-M3",
        "MiniMax-M2.7",
        "my-custom-model",
    ] {
        let (body, outcome) = capture_turn(model, history.as_array().unwrap(), &tools,
            "data: {\"choices\":[{\"delta\":{\"content\":\"Done\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n").await;
        assert_eq!(body["model"], model);
        assert_eq!(body["messages"], history);
        assert_eq!(body["tools"], tools);
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        for field in [
            "thinking",
            "reasoning_effort",
            "reasoning_split",
            "service_tier",
        ] {
            assert!(body.get(field).is_none(), "unexpected {field}");
        }
        assert_eq!(outcome.text, "Done");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn minimax_streamed_reasoning_survives_tool_continuation_and_eof() {
    let response = concat!(
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"First \"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"then second\",\"content\":\"<think>legacy</think>\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read_note\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":20}}\n\n"
    );
    for ending in ["data: [DONE]\n\n", ""] {
        let (_, outcome) = capture_turn(
            "MiniMax-M3.1-Flash",
            &[],
            &serde_json::json!([]),
            &format!("{response}{ending}"),
        )
        .await;
        assert_eq!(outcome.reasoning_content, "First then second");
        assert_eq!(outcome.text, "<think>legacy</think>");
        assert_eq!(
            outcome.tool_uses,
            vec![("call_1".into(), "read_note".into(), serde_json::json!({}))]
        );
        assert_eq!((outcome.tokens_in, outcome.tokens_out), (10, 20));
        let mut assistant = serde_json::json!({"role":"assistant", "content":outcome.text, "tool_calls":[
            {"id":"call_1", "type":"function", "function":{"name":"read_note", "arguments":"{}"}}
        ]});
        preserve_minimax_reasoning("minimax", "MiniMax-M3.1-Flash", &outcome, &mut assistant);
        let history = vec![
            assistant,
            serde_json::json!({"role":"tool", "tool_call_id":"call_1", "content":"Result"}),
        ];
        let (body, _) = capture_turn(
            "MiniMax-M3.1-Flash",
            &history,
            &serde_json::json!([]),
            "data: [DONE]\n\n",
        )
        .await;
        assert_eq!(
            body["messages"][0]["reasoning_content"],
            "First then second"
        );
        assert_eq!(body["messages"][0]["content"], "<think>legacy</think>");
        assert_eq!(body["messages"][1]["tool_call_id"], "call_1");
        let mut unrelated = serde_json::json!({"role":"assistant"});
        preserve_minimax_reasoning("openai", "custom", &outcome, &mut unrelated);
        assert!(unrelated.get("reasoning_content").is_none());
    }
}

#[test]
fn minimax_regions_and_custom_paths_are_preserved() {
    for base in [
        "https://api.minimax.io/v1",
        "https://api.minimaxi.com/v1",
        "https://gateway.example.invalid/custom/v1",
    ] {
        assert_eq!(openai_base(Some(base)), base);
    }
}
