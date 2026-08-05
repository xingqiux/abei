<?php
declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\User;

use FireflyIII\Api\V1\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Issues personal access tokens for first-party web clients.
 */
class TokenController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        $result = $request->user()->createToken('granary-web');

        return response()->json(['data' => ['access_token' => $result->accessToken]]);
    }
}
