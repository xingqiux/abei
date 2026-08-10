//! 输出通道。
//!
//! 数据走 stdout、进度和提示走 stderr，管道下游提前关掉（`abei tx list | head`）时
//! 不能 panic —— 所以这里不用 `println!`，一律显式 write 并把 BrokenPipe 交给上层
//! 当作正常结束。

use std::io::{self, IsTerminal, Write};

pub struct Io {
    out: Box<dyn Write + Send>,
    err: Box<dyn Write + Send>,
    /// stdout 是不是终端。决定要不要上色、画表格边框。
    pub tty: bool,
}

impl Io {
    /// 真实终端。颜色交给 anstream 按 NO_COLOR / CLICOLOR / 管道情况自动降级。
    pub fn stdio() -> Self {
        let tty = io::stdout().is_terminal();
        Self {
            out: Box::new(anstream::stdout()),
            err: Box::new(anstream::stderr()),
            tty,
        }
    }

    /// 测试用：输出收进内存。
    pub fn capture(out: SharedBuffer, err: SharedBuffer) -> Self {
        Self {
            out: Box::new(out),
            err: Box::new(err),
            tty: false,
        }
    }

    pub fn line(&mut self, text: &str) -> io::Result<()> {
        self.out.write_all(text.as_bytes())?;
        self.out.write_all(b"\n")
    }

    pub fn blank(&mut self) -> io::Result<()> {
        self.out.write_all(b"\n")
    }

    /// 提示、进度、错误都走 stderr，不污染管道里的数据。
    pub fn note(&mut self, text: &str) {
        let _ = self.err.write_all(text.as_bytes());
        let _ = self.err.write_all(b"\n");
    }

    pub fn flush(&mut self) {
        let _ = self.out.flush();
        let _ = self.err.flush();
    }
}

/// 测试里共享的输出缓冲。
#[derive(Clone, Default)]
pub struct SharedBuffer(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl SharedBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().expect("输出缓冲锁被毒化")).into_owned()
    }
}

impl Write for SharedBuffer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0
            .lock()
            .expect("输出缓冲锁被毒化")
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_output_is_readable() {
        let out = SharedBuffer::new();
        let err = SharedBuffer::new();
        let mut io = Io::capture(out.clone(), err.clone());
        io.line("数据").unwrap();
        io.note("提示");
        assert_eq!(out.text(), "数据\n");
        assert_eq!(err.text(), "提示\n");
    }

    /// 捕获模式不算终端，表格才不会带上颜色码。
    #[test]
    fn captured_io_is_not_a_tty() {
        let io = Io::capture(SharedBuffer::new(), SharedBuffer::new());
        assert!(!io.tty);
    }
}
