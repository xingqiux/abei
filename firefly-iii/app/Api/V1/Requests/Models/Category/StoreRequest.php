<?php

/**
 * CategoryStoreRequest.php
 * Copyright (c) 2019 james@firefly-iii.org
 *
 * This file is part of Firefly III (https://github.com/firefly-iii).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

declare(strict_types=1);

namespace FireflyIII\Api\V1\Requests\Models\Category;

use FireflyIII\Services\Category\DefaultCategorySet;
use FireflyIII\Support\Request\ChecksLogin;
use FireflyIII\Support\Request\ConvertsDataTypes;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Class StoreRequest
 */
class StoreRequest extends FormRequest
{
    use ChecksLogin;
    use ConvertsDataTypes;

    protected array $acceptedRoles = [];

    /**
     * Get all data from the request.
     */
    public function getAll(): array
    {
        $data = [
            'name'      => $this->convertString('name'),
            'notes'     => $this->stringWithNewlines('notes'),
            'parent_id' => $this->nullableInteger('parent_id'),
            'icon'      => $this->nullableString('icon'),
            'color'     => $this->nullableString('color'),
        ];
        if ($this->has('domain')) {
            $data['domain'] = $this->convertString('domain');
        }

        return $data;
    }

    /**
     * The rules that the incoming request must be matched against.
     *
     * 名字唯一性不在这里判：现在只要求同级唯一，跨父级重名是合法的，
     * 这条规矩连同两级限制一起放在 CategoryHierarchyService。
     *
     * domain 只有建分类的时候能选，之后改不了——报表口径认的就是它，
     * 一条支出分类中途变成资金往来，历史统计会当场对不上。
     */
    public function rules(): array
    {
        return [
            'name'      => 'required|min:1|max:100',
            'parent_id' => 'nullable|numeric',
            'domain'    => 'nullable|in:'.implode(',', DefaultCategorySet::DOMAINS),
            'icon'      => 'nullable|string|max:64',
            'color'     => 'nullable|in:'.implode(',', DefaultCategorySet::COLORS),
        ];
    }

    /**
     * 空字符串当「没有」，不是当「设成空」。图标和色号要么有值要么是 null。
     */
    private function nullableString(string $field): ?string
    {
        $value = $this->convertString($field);

        return '' === $value ? null : $value;
    }
}
