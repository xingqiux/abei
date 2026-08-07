<?php
declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\User;

use FireflyIII\Api\V1\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Laravel\Passport\Token;

/**
 * Issues, lists and revokes personal access tokens for first-party web clients.
 */
class TokenController extends Controller
{
    /**
     * GET /api/v1/tokens
     * List the current user's non-revoked personal access tokens.
     */
    public function index(Request $request): JsonResponse
    {
        $tokens = Token::where('user_id', $request->user()->id)
            ->where('revoked', false)
            ->whereHas('client', static fn ($query) => $query->whereJsonContains('grant_types', 'personal_access'))
            ->orderByDesc('created_at')
            ->get(['id', 'name', 'created_at', 'expires_at']);

        return response()->json([
            'data' => $tokens->map(static fn (Token $token): array => [
                'id'         => $token->id,
                'name'       => $token->name,
                'created_at' => $token->created_at?->toIso8601String(),
                'expires_at' => $token->expires_at?->toIso8601String(),
                'current'    => $token->id === optional($request->user()->token())->id,
            ])->values(),
        ]);
    }

    /**
     * POST /api/v1/tokens
     * Issue a new personal access token. The name is caller-supplied and defaults to abaku-web.
     */
    public function store(Request $request): JsonResponse
    {
        $name   = (string) $request->input('name', 'abaku-web');
        $result = $request->user()->createToken(mb_substr($name, 0, 60));

        return response()->json([
            'data' => [
                'id'           => $result->token->id,
                'name'         => $result->token->name,
                'access_token' => $result->accessToken,
            ],
        ], 201);
    }

    /**
     * DELETE /api/v1/tokens/{id}
     * Revoke a personal access token owned by the current user.
     */
    public function destroy(Request $request, string $id): JsonResponse
    {
        $token = Token::where('id', $id)->where('user_id', $request->user()->id)->first();
        if (null === $token) {
            return response()->json(['message' => 'Token not found.'], 404);
        }
        $token->revoke();

        return response()->json([], 204);
    }
}
