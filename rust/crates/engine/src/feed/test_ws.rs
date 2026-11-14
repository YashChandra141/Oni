//! Test-only helpers for the mock venue WebSocket servers.

use tokio_tungstenite::tungstenite::handshake::server::{
    Callback, ErrorResponse, Request, Response,
};

/// A handshake callback that records the lowercase request header names, so tests can check
/// that the adapters send no auth headers (Req 5.3).
///
/// A named `Callback` impl instead of a closure: the `Result<Response, ErrorResponse>` shape is
/// fixed by tungstenite, and a trait impl does not trip `clippy::result_large_err`.
pub(crate) struct HeaderNames<'a>(pub(crate) &'a mut Vec<String>);

impl Callback for HeaderNames<'_> {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        self.0
            .extend(request.headers().keys().map(|k| k.as_str().to_owned()));
        Ok(response)
    }
}
