<?php

/**
 * CategoryUpdateRequest.php
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
 * Class UpdateRequest
 */
class UpdateRequest extends FormRequest
{
    use ChecksLogin;
    use ConvertsDataTypes;

    protected array $acceptedRoles = [];

    /**
     * Get all data from the request.
     */
    public function getAll(): array
    {
        $fields = [
            'name'      => ['name', 'convertString'],
            'notes'     => ['notes', 'stringWithNewlines'],
            'parent_id' => ['parent_id', 'nullableInteger'],
            'icon'      => ['icon', 'nullableString'],
            'color'     => ['color', 'nullableString'],
            'disabled'  => ['disabled', 'booleanFromField'],
        ];

        return $this->getAllData($fields);
    }

    /**
     * The rules that the incoming request must be matched against.
     *
     * 同级重名和两级限制都在 CategoryHierarchyService 判，见 StoreRequest 的说明。
     * parent_id 传 null 表示把分类挪回顶层。
     *
     * domain 建完就定死，所以这里直接 prohibited：静默忽略的话调用方会以为改成功了。
     * disabled 是布尔，落库时映射成 disabled_at 的时间戳。
     */
    public function rules(): array
    {
        return [
            'name'      => 'min:1|max:100',
            'parent_id' => 'nullable|numeric',
            'domain'    => 'prohibited',
            'icon'      => 'nullable|string|max:64',
            'color'     => 'nullable|in:'.implode(',', DefaultCategorySet::COLORS),
            'disabled'  => 'nullable|boolean',
        ];
    }

    private function booleanFromField(string $field): bool
    {
        return $this->boolean($field);
    }

    /**
     * 空字符串当「清掉」：改图标的弹窗里点「不要图标」传的就是空串。
     */
    private function nullableString(string $field): ?string
    {
        $value = $this->convertString($field);

        return '' === $value ? null : $value;
    }
}
