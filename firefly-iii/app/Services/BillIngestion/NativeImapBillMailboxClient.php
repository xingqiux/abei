<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Illuminate\Support\Facades\Log;
use RuntimeException;

class NativeImapBillMailboxClient implements ImapBillMailboxClient
{
    /** @var null|resource */
    private $stream = null;

    private int $tag = 1;

    public function close(): void
    {
        if (is_resource($this->stream)) {
            try {
                $this->writeCommand('LOGOUT');
            } catch (\Throwable $exception) {
                Log::debug('IMAP logout failed while closing the local stream.', ['exception_class' => $exception::class]);
            }
            fclose($this->stream);
        }

        $this->stream = null;
    }

    public function connect(BillMailboxConfig $config): void
    {
        $stream = $this->openStream($config);

        stream_set_timeout($stream, 30);
        $this->stream = $stream;
        $this->readUntilTagged('');
        if ('starttls' === $config->encryption) {
            $this->writeCommand('STARTTLS');
            $this->enableTls($stream, $config->host, 'Could not enable STARTTLS for IMAP mailbox.');
        }

        $this->writeCommand(sprintf('LOGIN %s %s', $this->quote($config->username), $this->quote($config->password)));
    }

    public function fetchRawMessage(string $uid): string
    {
        $raw = $this->fetchLiteral(sprintf('UID FETCH %s BODY.PEEK[]', $uid));

        if ('' === $raw) {
            throw new RuntimeException(sprintf('IMAP message %s did not return a raw body.', $uid));
        }

        return $raw;
    }

    public function markSeen(string $uid): void
    {
        $this->writeCommand(sprintf('UID STORE %s +FLAGS.SILENT (\\Seen)', $uid));
    }

    public function search(string $criteria, int $limit): array
    {
        $lines = $this->writeCommand(sprintf('UID SEARCH %s', $criteria));
        $uids  = [];

        foreach ($lines as $line) {
            if (1 === preg_match('/^\* SEARCH\s*(.*)$/', $line, $matches)) {
                $found = preg_split('/\s+/', trim($matches[1]));
                $found = false === $found ? [] : $found;
                foreach ($found as $uid) {
                    if ('' !== $uid) {
                        $uids[] = $uid;
                    }
                }
            }
        }

        return array_slice($uids, 0, max(1, $limit));
    }

    public function selectFolder(string $folder): void
    {
        $this->writeCommand(sprintf('SELECT %s', $this->quoteMailbox($folder)));
    }

    private function quote(string $value): string
    {
        return '"'.str_replace(['\\', '"'], ['\\\\', '\\"'], $value).'"';
    }

    private function quoteMailbox(string $folder): string
    {
        if (preg_match('/^[A-Za-z0-9_\-\/\[\] ]+$/', $folder)) {
            return $this->quote($folder);
        }

        return $this->quote('INBOX');
    }

    /**
     * @return resource
     */
    private function openStream(BillMailboxConfig $config)
    {
        $proxy = $this->proxyFromEnvironment($config->host);
        if (null !== $proxy) {
            return $this->openProxyStream($config, $proxy);
        }

        $scheme       = 'ssl' === $config->encryption ? 'ssl' : 'tcp';
        $remoteSocket = sprintf('%s://%s:%d', $scheme, $config->host, $config->port);
        $stream       = $this->openSocket($remoteSocket, $errno, $errstr);
        if (false === $stream) {
            throw new RuntimeException(sprintf('Could not connect to IMAP mailbox: %s', '' === $errstr ? (string) $errno : $errstr));
        }

        return $stream;
    }

    /**
     * @param array{host:string,port:int,user?:string,pass?:string} $proxy
     *
     * @return resource
     */
    private function openProxyStream(BillMailboxConfig $config, array $proxy)
    {
        $stream = $this->openSocket(sprintf('tcp://%s:%d', $proxy['host'], $proxy['port']), $errno, $errstr);
        if (false === $stream) {
            throw new RuntimeException(sprintf('Could not connect to IMAP proxy: %s', '' === $errstr ? (string) $errno : $errstr));
        }

        stream_set_timeout($stream, 30);
        $this->establishProxyTunnel($stream, $config, $proxy);
        if ('ssl' === $config->encryption) {
            $this->enableTls($stream, $config->host, 'Could not enable TLS for proxied IMAP mailbox.');
        }

        return $stream;
    }

    /**
     * @return false|resource
     */
    private function openSocket(string $remoteSocket, ?int &$errno, ?string &$errstr)
    {
        set_error_handler(static fn (): bool => true);

        try {
            return stream_socket_client($remoteSocket, $errno, $errstr, 30);
        } finally {
            restore_error_handler();
        }
    }

    /**
     * @param resource                                      $stream
     * @param array{host:string,port:int,user?:string,pass?:string} $proxy
     */
    private function establishProxyTunnel($stream, BillMailboxConfig $config, array $proxy): void
    {
        $target  = sprintf('%s:%d', $config->host, $config->port);
        $headers = [
            sprintf('CONNECT %s HTTP/1.1', $target),
            sprintf('Host: %s', $target),
            'Proxy-Connection: Keep-Alive',
        ];
        if (null !== ($proxy['user'] ?? null)) {
            $headers[] = 'Proxy-Authorization: Basic '.base64_encode($proxy['user'].':'.($proxy['pass'] ?? ''));
        }
        fwrite($stream, implode("\r\n", $headers)."\r\n\r\n");

        $statusLine = fgets($stream);
        if (false === $statusLine || 1 !== preg_match('#^HTTP/\d(?:\.\d)?\s+200\b#i', $statusLine)) {
            throw new RuntimeException(sprintf('Could not establish IMAP proxy tunnel: %s', trim(false === $statusLine ? '' : $statusLine)));
        }
        while (false !== ($line = fgets($stream))) {
            if ("\r\n" === $line || "\n" === $line) {
                return;
            }
        }

        throw new RuntimeException('IMAP proxy tunnel closed unexpectedly.');
    }

    /**
     * @return null|array{host:string,port:int,user?:string,pass?:string}
     */
    private function proxyFromEnvironment(string $host): ?array
    {
        if ($this->matchesNoProxy($host)) {
            return null;
        }

        foreach (['BILL_INBOX_IMAP_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as $name) {
            if ('HTTP_PROXY' === $name && false !== getenv('REQUEST_METHOD')) {
                continue;
            }
            $value = getenv($name);
            if (is_string($value) && '' !== trim($value)) {
                return $this->parseProxyUrl(trim($value));
            }
        }

        return null;
    }

    private function matchesNoProxy(string $host): bool
    {
        $host = strtolower($host);
        $list = array_find(
            [getenv('NO_PROXY'), getenv('no_proxy')],
            static fn (false|string $value): bool => false !== $value && '' !== $value && '0' !== $value,
        ) ?? '';
        foreach (explode(',', (string) $list) as $entry) {
            $entry = strtolower(trim($entry));
            if ('' === $entry) {
                continue;
            }
            if ('*' === $entry) {
                return true;
            }
            $entry = ltrim(explode(':', $entry, 2)[0], '.');
            if ($host === $entry || str_ends_with($host, '.'.$entry)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @return null|array{host:string,port:int,user?:string,pass?:string}
     */
    private function parseProxyUrl(string $url): ?array
    {
        if (!str_contains($url, '://')) {
            $url = 'http://'.$url;
        }
        $parts = parse_url($url);
        if (false === $parts || 'http' !== strtolower((string) ($parts['scheme'] ?? 'http')) || null === ($parts['host'] ?? null)) {
            return null;
        }

        $proxy = [
            'host' => (string) $parts['host'],
            'port' => (int) ($parts['port'] ?? 80),
        ];
        if (null !== ($parts['user'] ?? null)) {
            $proxy['user'] = rawurldecode((string) $parts['user']);
            $proxy['pass'] = rawurldecode((string) ($parts['pass'] ?? ''));
        }

        return $proxy;
    }

    /**
     * @param resource $stream
     */
    private function enableTls($stream, string $peerName, string $error): void
    {
        stream_context_set_option($stream, 'ssl', 'peer_name', $peerName);
        if (false === stream_socket_enable_crypto($stream, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            throw new RuntimeException($error);
        }
    }

    private function fetchLiteral(string $command): string
    {
        if (!is_resource($this->stream)) {
            throw new RuntimeException('IMAP client is not connected.');
        }

        $tag = sprintf('A%04d', $this->tag++);
        fwrite($this->stream, sprintf("%s %s\r\n", $tag, $command));

        $raw = '';
        while (false !== ($line = fgets($this->stream))) {
            if (1 === preg_match('/\{(\d+)\}\r?\n?$/', $line, $matches)) {
                $raw = $this->readBytes((int) $matches[1]);

                continue;
            }

            if (str_starts_with($line, $tag.' ')) {
                if (str_contains($line, ' OK')) {
                    return $raw;
                }

                throw new RuntimeException(sprintf('IMAP command failed: %s', trim($line)));
            }
        }

        throw new RuntimeException('IMAP connection closed unexpectedly.');
    }

    /**
     * @return array<int, string>
     */
    private function readUntilTagged(string $tag): array
    {
        if (!is_resource($this->stream)) {
            throw new RuntimeException('IMAP client is not connected.');
        }

        $lines = [];
        while (false !== ($line = fgets($this->stream))) {
            $lines[] = $line;
            if ('' !== $tag && str_starts_with($line, $tag.' ')) {
                if (str_contains($line, ' OK')) {
                    return $lines;
                }

                throw new RuntimeException(sprintf('IMAP command failed: %s', trim($line)));
            }
            if ('' === $tag) {
                return $lines;
            }
        }

        throw new RuntimeException('IMAP connection closed unexpectedly.');
    }

    private function readBytes(int $length): string
    {
        if (!is_resource($this->stream)) {
            throw new RuntimeException('IMAP client is not connected.');
        }

        $buffer = '';
        while (strlen($buffer) < $length && false !== ($chunk = fread($this->stream, $length - strlen($buffer)))) {
            $buffer .= $chunk;
        }

        if (strlen($buffer) !== $length) {
            throw new RuntimeException('IMAP literal ended before all bytes were read.');
        }

        return $buffer;
    }

    /**
     * @return array<int, string>
     */
    private function writeCommand(string $command): array
    {
        if (!is_resource($this->stream)) {
            throw new RuntimeException('IMAP client is not connected.');
        }

        $tag = sprintf('A%04d', $this->tag++);
        fwrite($this->stream, sprintf("%s %s\r\n", $tag, $command));

        return $this->readUntilTagged($tag);
    }
}
