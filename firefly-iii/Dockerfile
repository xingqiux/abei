FROM node:25-alpine AS assets

WORKDIR /app
COPY package.json package-lock.json ./
COPY resources/assets/v1/package.json resources/assets/v1/package.json
COPY resources/assets/v2/package.json resources/assets/v2/package.json
COPY patches ./patches
RUN npm ci
COPY resources/assets ./resources/assets
COPY public ./public
RUN npm --workspace resources/assets/v1 run production \
  && npm --workspace resources/assets/v2 run build

FROM php:8.5-apache AS app

ENV APACHE_DOCUMENT_ROOT=/var/www/html/public

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    curl \
    git \
    libcurl4-openssl-dev \
    libicu-dev \
    libonig-dev \
    libpq-dev \
    libzip-dev \
    locales \
    unzip \
  && printf 'en_US.UTF-8 UTF-8\nzh_CN.UTF-8 UTF-8\n' > /etc/locale.gen \
  && locale-gen \
  && update-locale LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 \
  && docker-php-ext-install -j"$(nproc)" \
    bcmath \
    intl \
    pdo_pgsql \
    pgsql \
    zip \
  && a2enmod rewrite headers \
  && sed -ri "s!/var/www/html!${APACHE_DOCUMENT_ROOT}!g" /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf /etc/apache2/conf-available/*.conf \
  && printf '<Directory %s>\n    AllowOverride All\n    Require all granted\n</Directory>\n' "${APACHE_DOCUMENT_ROOT}" > /etc/apache2/conf-available/firefly.conf \
  && a2enconf firefly \
  && rm -rf /var/lib/apt/lists/*

ENV LANG=zh_CN.UTF-8 \
  LC_ALL=zh_CN.UTF-8

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html
COPY composer.json composer.lock ./
COPY app ./app
COPY bootstrap ./bootstrap
COPY config ./config
COPY database ./database
COPY resources ./resources
COPY routes ./routes
COPY artisan ./
RUN rm -f bootstrap/cache/*.php \
  && composer install --no-dev --no-scripts --no-interaction --no-progress --optimize-autoloader \
  && composer dump-autoload --no-dev --no-interaction --optimize

COPY public ./public
COPY --from=assets /app/public/build ./public/build
COPY --from=assets /app/public/v1/js ./public/v1/js

COPY docker/entrypoint.sh /usr/local/bin/firefly-entrypoint
RUN chmod +x /usr/local/bin/firefly-entrypoint \
  && mkdir -p storage bootstrap/cache \
  && chown -R www-data:www-data storage bootstrap/cache

ENTRYPOINT ["firefly-entrypoint"]
CMD ["apache2-foreground"]

FROM app AS test

COPY tests ./tests
COPY phpunit.xml ./
COPY mago.toml ./
RUN printf 'memory_limit=512M\n' > /usr/local/etc/php/conf.d/zz-test-memory.ini \
  && composer install --no-scripts --no-interaction --no-progress \
  && composer dump-autoload --no-interaction --optimize \
  && vendor/bin/mago --version

FROM app AS production
