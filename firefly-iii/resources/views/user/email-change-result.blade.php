{{-- 邮箱变更确认/撤销链接的落地页。用户是从邮件点进来的，所以返回页面而不是 JSON。 --}}
@extends('layout.v2.page')
@section('status', $title)
@section('content')
    <p>{{ $message }}</p>
@endsection
