<?php

declare(strict_types=1);

namespace Tests\unit\Services\BillIngestion;

use FireflyIII\Services\BillIngestion\NativeImapBillMailboxClient;
use FireflyIII\Services\BillIngestion\BillMailboxConfig;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

/**
 * @internal
 *
 * @covers \FireflyIII\Services\BillIngestion\NativeImapBillMailboxClient
 */
final class NativeImapBillMailboxClientTest extends TestCase
{
    protected function tearDown(): void
    {
        foreach (['BILL_INBOX_IMAP_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'] as $name) {
            putenv($name);
        }

        parent::tearDown();
    }

    public function testReadBytesKeepsBinaryMailboxLiteralsIntact(): void
    {
        $client = new NativeImapBillMailboxClient();
        $stream = fopen('php://temp', 'r+');
        fwrite($stream, "line one\r\nzip\0bytes\r\nline three");
        rewind($stream);

        $reflection = new ReflectionClass($client);
        $property   = $reflection->getProperty('stream');
        $property->setValue($client, $stream);

        $method = $reflection->getMethod('readBytes');
        $message = "line one\r\nzip\0bytes\r\nline three";
        $result  = $method->invoke($client, strlen($message));

        $this->assertSame($message, $result);
    }

    public function testProxyFromEnvironmentPrefersExplicitBillInboxProxy(): void
    {
        putenv('BILL_INBOX_IMAP_PROXY=http://user%40name:pa%3Ass@172.19.0.1:17890');
        putenv('HTTPS_PROXY=http://ignored.example:8080');

        $client = new NativeImapBillMailboxClient();
        $method = (new ReflectionClass($client))->getMethod('proxyFromEnvironment');

        $this->assertSame([
            'host' => '172.19.0.1',
            'port' => 17_890,
            'user' => 'user@name',
            'pass' => 'pa:ss',
        ], $method->invoke($client, 'imap.gmail.com'));
    }

    public function testNoProxySkipsMatchingImapHost(): void
    {
        putenv('BILL_INBOX_IMAP_PROXY=http://172.19.0.1:17890');
        putenv('NO_PROXY=localhost,.gmail.com');

        $client = new NativeImapBillMailboxClient();
        $method = (new ReflectionClass($client))->getMethod('proxyFromEnvironment');

        $this->assertNull($method->invoke($client, 'imap.gmail.com'));
    }

    public function testOpenSocketAcceptsNullableErrorOutputs(): void
    {
        $server = stream_socket_server('tcp://127.0.0.1:0');
        $this->assertIsResource($server);
        $address = stream_socket_get_name($server, false);
        $this->assertIsString($address);

        $client = new NativeImapBillMailboxClient();
        $method = (new ReflectionClass($client))->getMethod('openSocket');
        $errno  = null;
        $errstr = null;
        $arguments = [sprintf('tcp://%s', $address), &$errno, &$errstr];
        $stream = $method->invokeArgs($client, $arguments);

        $this->assertIsResource($stream);
        fclose($stream);
        fclose($server);
    }

    public function testEstablishProxyTunnelSendsConnectRequest(): void
    {
        $client = new NativeImapBillMailboxClient();
        $pair   = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP);
        $this->assertIsArray($pair);
        [$clientStream, $proxyStream] = $pair;
        fwrite($proxyStream, "HTTP/1.1 200 Connection established\r\nProxy-Agent: test\r\n\r\n");

        $method = (new ReflectionClass($client))->getMethod('establishProxyTunnel');
        $method->invoke($client, $clientStream, $this->mailboxConfig(), [
            'host' => '172.19.0.1',
            'port' => 17_890,
            'user' => 'proxy-user',
            'pass' => 'proxy-pass',
        ]);

        stream_set_blocking($proxyStream, false);
        $request = stream_get_contents($proxyStream);
        $this->assertStringContainsString("CONNECT imap.gmail.com:993 HTTP/1.1\r\n", $request);
        $this->assertStringContainsString("Host: imap.gmail.com:993\r\n", $request);
        $this->assertStringContainsString("Proxy-Authorization: Basic cHJveHktdXNlcjpwcm94eS1wYXNz\r\n", $request);

        fclose($clientStream);
        fclose($proxyStream);
    }

    private function mailboxConfig(): BillMailboxConfig
    {
        return new BillMailboxConfig(
            enabled: true,
            provider: 'gmail',
            email: 'money@example.com',
            host: 'imap.gmail.com',
            port: 993,
            encryption: 'ssl',
            username: 'money@example.com',
            password: 'gmail-app-password',
            folder: 'INBOX',
            rules: [],
        );
    }
}
