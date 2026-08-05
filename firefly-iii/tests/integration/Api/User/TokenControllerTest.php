<?php

declare(strict_types=1);

namespace Tests\integration\Api\User;

use FireflyIII\Models\GroupMembership;
use FireflyIII\Models\UserGroup;
use FireflyIII\Models\UserRole;
use FireflyIII\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Passport\Client;
use Laravel\Passport\ClientRepository;
use Laravel\Passport\Token;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\integration\TestCase;

/**
 * Class TokenControllerTest
 *
 * 个人访问令牌的签发/列出/撤销，abaku-web 用这三个端点管理自己的令牌。
 *
 * @internal
 *
 * @coversNothing
 */
final class TokenControllerTest extends TestCase
{
    use RefreshDatabase;

    public static function nameProvider(): array
    {
        return [
            '缺省用 abaku-web'   => [null, 'abaku-web'],
            '调用方指定名字'     => ['macbook', 'macbook'],
            '超过 60 字符被截断' => [str_repeat('x', 200), str_repeat('x', 60)],
            // mb_substr 按字符截，不是按字节，中文名不会被砍成半个字。
            '中文名按字符截断'   => [str_repeat('账', 100), str_repeat('账', 60)],
        ];
    }

    public function testIndexReturnsOnlyTheCurrentUsersTokens(): void
    {
        $this->createPersonalAccessClient();
        $mine    = $this->createUser('mine@email.com');
        $other   = $this->createUser('other@email.com');

        $myToken = $mine->createToken('mine')->token;
        $their   = $other->createToken('theirs')->token;

        $this->actingAs($mine, 'api');
        $response = $this->get(route('api.v1.user.tokens.index'), ['Accept' => 'application/json']);

        $response->assertStatus(200);
        $ids     = $this->tokenIds($response->json('data'));
        $this->assertSame([$myToken->id], $ids);
        $this->assertNotContains($their->id, $ids);
    }

    public function testIndexHidesRevokedTokens(): void
    {
        $this->createPersonalAccessClient();
        $user    = $this->createUser('revoked@email.com');

        $live    = $user->createToken('live')->token;
        $dead    = $user->createToken('dead')->token;
        $dead->revoke();

        $this->actingAs($user, 'api');
        $response = $this->get(route('api.v1.user.tokens.index'), ['Accept' => 'application/json']);

        $response->assertStatus(200);
        $ids     = $this->tokenIds($response->json('data'));
        $this->assertSame([$live->id], $ids);
        $this->assertNotContains($dead->id, $ids);
    }

    /**
     * index() 用 whereHas('client', personal_access grant) 过滤，所以挂在别的 client 上的
     * 令牌（密码授权、授权码等）不出现在列表里。
     */
    public function testIndexHidesTokensThatAreNotPersonalAccessTokens(): void
    {
        $this->createPersonalAccessClient();
        $user       = $this->createUser('mixed@email.com');

        $personal   = $user->createToken('personal')->token;

        /** @var ClientRepository $clients */
        $clients    = app(ClientRepository::class);
        $otherClient = $clients->createPasswordGrantClient('password grant client', 'users');
        $foreign    = $this->makeRawToken($user, $otherClient, 'password grant token');

        $this->actingAs($user, 'api');
        $response   = $this->get(route('api.v1.user.tokens.index'), ['Accept' => 'application/json']);

        $response->assertStatus(200);
        $ids        = $this->tokenIds($response->json('data'));
        $this->assertSame([$personal->id], $ids);
        $this->assertNotContains($foreign->id, $ids);
    }

    /**
     * current 标记的是「这次请求用的那个令牌」，所以必须发真的 Bearer 请求：
     * actingAs($user, 'api') 不会给 user 挂上 access token，token() 恒为 null。
     */
    public function testIndexMarksTheTokenUsedForThisRequestAsCurrent(): void
    {
        $this->createPersonalAccessClient();
        $user     = $this->createUser('current@email.com');

        $used     = $user->createToken('used for this request');
        $unused   = $user->createToken('some other device')->token;

        $response = $this->withToken($used->accessToken)
            ->getJson(route('api.v1.user.tokens.index'))
        ;

        $response->assertStatus(200);
        $flags    = $this->currentFlags($response->json('data'));
        $this->assertTrue($flags[$used->token->id]);
        $this->assertFalse($flags[$unused->id]);
    }

    public function testStoreIssuesATokenAndReturnsThePlainTextSecret(): void
    {
        $this->createPersonalAccessClient();
        $user     = $this->createUser('store@email.com');

        $this->actingAs($user, 'api');
        $response = $this->postJson(route('api.v1.user.tokens.store'), ['name' => 'macbook']);

        $response->assertStatus(201);
        $response->assertJsonStructure(['data' => ['id', 'name', 'access_token']]);

        $id       = (string) $response->json('data.id');
        $secret   = (string) $response->json('data.access_token');
        $this->assertNotSame('', $secret);
        // 明文令牌是 JWT，不是数据库主键，绝不能把 id 当令牌返回。
        $this->assertNotSame($id, $secret);
        $this->assertStringStartsWith('eyJ', $secret);

        $stored   = Token::find($id);
        $this->assertNotNull($stored);
        $this->assertSame($user->id, (int) $stored->user_id);
        $this->assertFalse((bool) $stored->revoked);
    }

    #[DataProvider('nameProvider')]
    public function testStoreNamesTheToken(?string $submitted, string $expected): void
    {
        $this->createPersonalAccessClient();
        $user     = $this->createUser('naming@email.com');

        $this->actingAs($user, 'api');
        $response = $this->postJson(
            route('api.v1.user.tokens.store'),
            null === $submitted ? [] : ['name' => $submitted]
        );

        $response->assertStatus(201);
        $this->assertSame($expected, $response->json('data.name'));
        $this->assertSame($expected, Token::find((string) $response->json('data.id'))->name);
    }

    public function testDestroyRevokesOwnToken(): void
    {
        $this->createPersonalAccessClient();
        $user     = $this->createUser('destroy@email.com');
        $token    = $user->createToken('to be revoked')->token;

        $this->actingAs($user, 'api');
        $response = $this->delete(
            route('api.v1.user.tokens.destroy', [$token->id]),
            [],
            ['Accept' => 'application/json']
        );

        $response->assertStatus(204);
        $this->assertTrue((bool) Token::find($token->id)->revoked);
    }

    /**
     * 越权防护：拿别人的令牌 id 来撤销，必须 404，而且那个令牌不能真被撤销。
     */
    public function testDestroyRefusesToRevokeAnotherUsersToken(): void
    {
        $this->createPersonalAccessClient();
        $attacker = $this->createUser('attacker@email.com');
        $victim   = $this->createUser('victim@email.com');
        $target   = $victim->createToken('victim device')->token;

        $this->actingAs($attacker, 'api');
        $response = $this->delete(
            route('api.v1.user.tokens.destroy', [$target->id]),
            [],
            ['Accept' => 'application/json']
        );

        $response->assertStatus(404);
        $this->assertFalse((bool) Token::find($target->id)->revoked);
    }

    public function testDestroyReturnsNotFoundForAnUnknownToken(): void
    {
        $this->createPersonalAccessClient();
        $user     = $this->createUser('unknown@email.com');

        $this->actingAs($user, 'api');
        $response = $this->delete(
            route('api.v1.user.tokens.destroy', ['no-such-token-id']),
            [],
            ['Accept' => 'application/json']
        );

        $response->assertStatus(404);
    }

    private function createPersonalAccessClient(): Client
    {
        return app(ClientRepository::class)->createPersonalAccessGrantClient('abaku-web test client', 'users');
    }

    private function createUser(string $email): User
    {
        $group = UserGroup::create(['title' => $email]);
        $role  = UserRole::where('title', 'owner')->first();
        $user  = User::create(['email' => $email, 'password' => 'password', 'user_group_id' => $group->id]);

        GroupMembership::create(['user_id' => $user->id, 'user_group_id' => $group->id, 'user_role_id' => $role->id]);

        return $user;
    }

    /**
     * 直接写一行 oauth_access_tokens，用来造「不是个人访问令牌」的场景。
     */
    private function makeRawToken(User $user, Client $client, string $name): Token
    {
        return Token::create([
            'id'         => bin2hex(random_bytes(40)),
            'user_id'    => $user->id,
            'client_id'  => $client->id,
            'name'       => $name,
            'scopes'     => [],
            'revoked'    => false,
            'expires_at' => now()->addYear(),
        ]);
    }

    /**
     * @param array<int, array<string, mixed>> $data
     *
     * @return array<int, string>
     */
    private function tokenIds(array $data): array
    {
        return array_map(static fn (array $row): string => (string) $row['id'], $data);
    }

    /**
     * @param array<int, array<string, mixed>> $data
     *
     * @return array<string, bool>
     */
    private function currentFlags(array $data): array
    {
        $flags = [];
        foreach ($data as $row) {
            $flags[(string) $row['id']] = (bool) $row['current'];
        }

        return $flags;
    }
}
