<?php
declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\System;

use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\User;
use Illuminate\Http\Response;

/**
 * Health check for container orchestration.
 */
final class HealthcheckController extends Controller
{
    /**
     * Sends 'OK' info when app is alive
     */
    public function check(): Response
    {
        User::count(); // sanity check for database health. Will crash if not OK.

        return response('OK', 200);
    }
}
