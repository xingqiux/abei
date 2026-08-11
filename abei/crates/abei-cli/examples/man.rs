fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdout = std::io::stdout();
    clap_mangen::Man::new(abei_cli::app::root_command()).render(&mut stdout.lock())?;
    Ok(())
}
