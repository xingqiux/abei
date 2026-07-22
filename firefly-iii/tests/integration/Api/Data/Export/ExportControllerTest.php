<?php

declare(strict_types=1);

namespace Tests\integration\Api\Data\Export;

use Tests\integration\TestCase;

/**
 * @internal
 *
 * @covers \FireflyIII\Api\V1\Controllers\Data\Export\ExportController
 */
final class ExportControllerTest extends TestCase
{
    public function testAllowsSingleDayCsvExportWithDownloadHeaders(): void
    {
        $this->actingAs($this->createAuthenticatedUser(), 'api');

        $response = $this->get(route('api.v1.data.export.accounts', [
            'type'  => 'csv',
            'start' => '2026-07-20',
            'end'   => '2026-07-20',
        ]));

        $response->assertOk();
        $this->assertStringStartsWith('text/csv', (string) $response->headers->get('Content-Type'));
        $this->assertStringContainsString('attachment; filename=', (string) $response->headers->get('Content-Disposition'));
    }
}
