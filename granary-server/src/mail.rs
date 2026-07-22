use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    transport::smtp::authentication::Credentials,
};

use crate::{auth::ApiError, http::AppState};

pub async fn send_text(
    state: &AppState,
    recipient: &str,
    subject: &str,
    body: String,
) -> Result<(), ApiError> {
    let message = Message::builder()
        .from(state.mail_from.parse().map_err(ApiError::internal)?)
        .to(recipient.parse().map_err(ApiError::internal)?)
        .subject(subject)
        .body(body)
        .map_err(ApiError::internal)?;
    let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&state.smtp_host)
        .port(state.smtp_port);
    if !state.smtp_username.is_empty() {
        builder = builder.credentials(Credentials::new(
            state.smtp_username.clone(),
            state.smtp_password.clone(),
        ));
    }
    builder
        .build()
        .send(message)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}
