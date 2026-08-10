use std::process::ExitCode;

use abei_cli::app;
use abei_cli::config::Settings;
use abei_cli::exit::Exit;
use abei_cli::io::Io;

#[tokio::main]
async fn main() -> ExitCode {
    let mut io = Io::stdio();
    let settings = Settings::resolve();
    let argv: Vec<String> = std::env::args().collect();

    // Ctrl-C 单独走 2 号退出码，跟「失败」区分开——脚本能据此判断是人喊停的。
    let exit = tokio::select! {
        exit = app::run(&mut io, settings, argv) => exit,
        _ = tokio::signal::ctrl_c() => Exit::Interrupted,
    };

    io.flush();
    ExitCode::from(exit.code())
}
