<?php

declare(strict_types=1);

namespace Tests\integration\Api\Models\Attachment;

use FireflyIII\Enums\AccountTypeEnum;
use FireflyIII\Models\Account;
use FireflyIII\User;
use Illuminate\Support\Facades\Storage;
use Tests\integration\TestCase;

/**
 * @internal
 *
 * @covers \FireflyIII\Api\V1\Controllers\Models\Attachment\StoreController
 */
final class AttachmentUploadPolicyTest extends TestCase
{
    private User $user;
    private Account $account;

    public function testAcceptsAllowedAttachmentAndRejectsUnsupportedOrSpoofedMime(): void
    {
        Storage::fake('upload');

        $unsupported = $this->createAttachment('program.exe');
        $this->upload($unsupported, 'MZ executable', 'application/x-msdownload')
            ->assertUnprocessable()
            ->assertJsonPath('message', 'Unsupported attachment type.');

        $supported = $this->createAttachment('receipt.txt');
        $this->upload($supported, 'synthetic receipt', 'text/plain')->assertNoContent();
        Storage::disk('upload')->assertExists(sprintf('at-%s.data', $supported));

        $spoofed = $this->createAttachment('fake.png');
        $this->upload($spoofed, "MZ".str_repeat("\0", 128)."PE\0\0", 'image/png')->assertUnprocessable();
        Storage::disk('upload')->assertMissing(sprintf('at-%s.data', $spoofed));
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->user    = $this->createAuthenticatedUser();
        $this->account = Account::factory()->withType(AccountTypeEnum::ASSET)->create([
            'user_id'       => $this->user->id,
            'user_group_id' => $this->user->user_group_id,
            'active'        => true,
        ]);
        $this->actingAs($this->user, 'api');
    }

    private function createAttachment(string $filename): string
    {
        $response = $this->postJson(route('api.v1.attachments.store'), [
            'filename'        => $filename,
            'title'           => $filename,
            'attachable_type' => 'Account',
            'attachable_id'   => $this->account->id,
        ]);
        $response->assertOk();

        return (string) $response->json('data.id');
    }

    private function upload(string $attachmentId, string $content, string $contentType): \Illuminate\Testing\TestResponse
    {
        return $this->call(
            'POST',
            route('api.v1.attachments.upload', ['attachment' => $attachmentId]),
            [],
            [],
            [],
            ['HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => $contentType],
            $content,
        );
    }
}
