#!/usr/bin/env sh
set -eu

# Laravel's file cache store (config/cache.php) writes to
# storage/framework/cache/data and does NOT recreate that nested directory
# itself if it is ever wiped (e.g. a fresh volume, or an operator clearing
# storage/). When it's missing, every API call fails with a 500:
#   file_put_contents(.../storage/framework/cache/data/xx/yy/...):
#   Failed to open stream: No such file or directory
# So it must exist (and be writable by www-data) before Apache starts.
mkdir -p \
  storage/app \
  storage/framework/cache/data \
  storage/framework/sessions \
  storage/framework/testing \
  storage/framework/views \
  storage/logs \
  storage/upload \
  bootstrap/cache

chown -R www-data:www-data storage bootstrap/cache

if [ "${FIREFLY_RUN_MIGRATIONS:-false}" = "true" ]; then
  php artisan migrate --force
  php artisan firefly-iii:upgrade-database
fi

exec docker-php-entrypoint "$@"
