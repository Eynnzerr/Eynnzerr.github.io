---
title: 'Android 文件访问：从绝对路径走向 Uri 与 SAF'
description: '从内部与外部存储的区别出发，按文件用途选择 API，并用文档选择、持久化授权和流式读取串起现代 Android 的文件访问模型。'
date: '2026-03-06T15:42:22+08:00'
categories: [Android, 存储]
tags: [Android, Uri, SAF, Scoped Storage]
updated: '2026-10-15'
---

拿到一个文件后先找“真实路径”，曾经是很常见的 Android 开发习惯。现代存储接口返回的往往是 `content://` Uri，它可能对应系统媒体项、云盘文档或另一个应用提供的内容。这时更有用的问题是：**谁提供这份内容、允许什么操作、授权能持续多久**。

理解这三个问题，需要先分清存储位置、访问规则和访问接口。

## External Storage 并不等于 SD 卡

Internal 与 External 是 Android 存储模型中的分类，不能直接对应“内置闪存”和“可拔出的存储卡”。很多设备把内置闪存的一部分作为模拟外部存储，常见路径中因而会出现 `emulated`。

同时，外部存储里既有公共内容，也有应用专属目录。不能把 External Storage 整体当成其他应用都能自由读写的区域。

| 用途 | 入口 | 生命周期与访问方式 |
| --- | --- | --- |
| 应用内部文件 | `filesDir` | 应用专属，卸载时删除 |
| 应用内部缓存 | `cacheDir` | 可被系统回收，卸载时删除 |
| 应用专属外部文件 | `getExternalFilesDir()` | 从 Android 4.4 起访问自己的目录无需存储权限；需考虑卷不可用 |
| 用户的共享图片、音视频 | MediaStore | 按媒体项访问，权限取决于来源、系统与目标版本 |
| 用户选择的文档或目录 | SAF | 用户选择后获得对应 Uri 授权 |

这些目录应通过 API 获取，而不是硬编码 `/sdcard/`。`getExternalFilesDirs()` 可以返回不同卷上的应用专属目录；数组位置不应被当成某种物理介质的永久身份证明。[应用专属文件](https://developer.android.com/training/data-storage/app-specific)

## Scoped Storage 与 SAF 处于不同层次

Scoped Storage 是共享存储的访问规则；SAF，也就是 Storage Access Framework，是用户选择文档并授予访问权的接口体系。

SAF 从 Android 4.4 就已存在，目录树选择从 Android 5.0 提供。Android 10 引入的分区存储让按用途、按授权访问文件成为更主要的开发方式，但 SAF 并不是 Android 10 才新增的接口。

对于现代、采用分区存储的应用，可以先按需求选择入口：

| 要做的事 | 合适的入口 |
| --- | --- |
| 保存只供应用使用的配置或缓存 | 应用专属存储 |
| 让用户挑选几张图片或视频 | Photo Picker |
| 保存应用生成的照片到系统相册 | MediaStore |
| 导入 PDF、文本或 ZIP | `ACTION_OPEN_DOCUMENT` 或适合导入流程的内容选择合约 |
| 导出到用户指定的新文档 | `ACTION_CREATE_DOCUMENT` |
| 访问用户指定的目录树 | `ACTION_OPEN_DOCUMENT_TREE` |

用户为 SAF 选择的文档授予访问权，不需要先申请读取整个存储区域的权限。目录选择也有边界：Android 11 及以上限制选择存储卷根目录、`Download` 根目录以及 `Android/data`、`Android/obb` 等位置。可以让用户选择 Download 中允许访问的具体文档，不等于可以获得整个 Download 目录树。[SAF 文档访问](https://developer.android.com/training/data-storage/shared/documents-files)

## 旧存储权限：先看系统版本，再看 targetSdk

`READ_EXTERNAL_STORAGE` 和 `WRITE_EXTERNAL_STORAGE` 的意义随系统版本和应用目标版本变化，不能笼统写成“所有版本都失效”。

- 在旧系统上，访问共享外部存储仍可能需要这些权限。
- Android 11 及以上，应用以 API 30 或更高版本为目标时，`WRITE_EXTERNAL_STORAGE` 不再增加存储访问能力。
- Android 13 及以上，应用以 API 33 或更高版本为目标、需要读取其他应用创建的媒体时，使用对应的 `READ_MEDIA_IMAGES`、`READ_MEDIA_VIDEO`、`READ_MEDIA_AUDIO`。
- Android 14 引入照片与视频的部分访问能力。自行实现媒体选择界面的应用，需要区分完整访问、部分访问和拒绝。

仅需要用户选定照片或文件时，Photo Picker 和 SAF 往往已经能满足需求。应先确定访问范围，再决定权限声明，而不是先把一组存储权限写进 Manifest。[Android 11 存储变化](https://developer.android.com/about/versions/11/privacy/storage)、[Android 13 媒体权限](https://developer.android.com/about/versions/13/behavior-changes-13#granular-media-permissions)、[Android 14 部分照片访问](https://developer.android.com/about/versions/14/changes/partial-photo-video-access)

## Uri 表达的是提供者眼中的资源

以这条 Uri 为例：

```text
content://media/external/images/media/12345
```

`content` 是 scheme，`media` 是 authority，后面的 path 在该提供者的规则中定位一个资源。`/external/images/media/12345` 不是应用可以直接传给 `File()` 的磁盘路径。

几种常见 scheme 对应不同访问方式：

| Scheme | 典型含义 | 常用入口 |
| --- | --- | --- |
| `content://` | ContentProvider 暴露的内容 | `ContentResolver` |
| `file://` | 文件系统中的文件 | 有相应文件访问权时使用文件 API |
| `https://` | 网络资源 | HTTP 客户端 |
| `android.resource://` | 应用资源 | Android 资源相关接口 |

`Uri.parse(text)` 与 `uri.toString()` 只是在对象和字符串之间转换，不执行权限申请，也不验证内容是否仍然存在。

对文档而言，通常直接打开流即可。以下示例读取用户选定的小型 UTF-8 文本；它放在 I/O 调度器上执行，并在完成时关闭流：

```kotlin
import android.content.ContentResolver
import android.net.Uri
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Read a small UTF-8 document for which the caller already holds access. */
suspend fun readTextDocument(resolver: ContentResolver, uri: Uri): String =
    withContext(Dispatchers.IO) {
        val stream = resolver.openInputStream(uri)
            ?: throw IOException("The document could not be opened")
        stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }
```

大文件应分块或逐行处理，而不是一次装入字符串。文档也可能来自远程提供者，所以一个看起来像本地地址的 Uri，仍可能触发耗时 I/O。

## 持久化的是授权，另行保存的是地址

`ACTION_OPEN_DOCUMENT` 适合需要反复打开原文档的场景。长期使用一份文档需要完成两件事：保存 Uri 字符串，以及保留系统允许持久化的授权。

下面用 `StartActivityForResult` 保留原始结果 Intent，读取其中实际授予的读写 flags。结果注册方式可参见 [Activity Result 合约](/2026/03/12/android-activity-result-contracts/)。

```kotlin
import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/** Choose a text document and remember its granted access across restarts. */
class DocumentPickerActivity : ComponentActivity() {
    /** Preserve the result Intent so the granted access flags remain available. */
    private val openDocument = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val uri = data?.data
            if (data != null && uri != null) {
                val access = data.flags and (
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or
                        Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    )
                try {
                    contentResolver.takePersistableUriPermission(uri, access)
                    getSharedPreferences("documents", MODE_PRIVATE)
                        .edit().putString("last_document", uri.toString()).apply()
                    Toast.makeText(this, "已记住文档", Toast.LENGTH_SHORT).show()
                } catch (error: SecurityException) {
                    Toast.makeText(this, "未能保留文档授权，请重新选择", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    /** Launch the system document picker from a user action. */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(Button(this).apply {
            text = "打开文本文档"
            setOnClickListener {
                openDocument.launch(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "text/plain"
                })
            }
        })
    }
}
```

再次打开时，从保存的字符串恢复 Uri，然后使用 `ContentResolver` 访问。文件被移动或删除、提供者不可用、授权被撤销，都可能使访问失败；界面应在这种具体失败后让用户重新选择。持久化授权只是把授权跨重启保留，不会复制文件，也不会固定它的存在状态。

如果业务只需要导入后的独立副本，可以读取选择结果并复制到应用自己的目录。这样“导入文件”和“持续编辑原文档”就是两种清楚的产品行为。

## DocumentFile 在哪里有用

`DocumentFile` 为文档或目录提供接近 File 的操作形式，例如读取名称、列出子项、创建或删除文档。通过 `fromTreeUri()` 得到的目录仍由 DocumentsProvider 管理，底层操作需要和提供者交互；它不会把 Uri 变成一个可以任意遍历的本地路径。

少量文档操作用它很方便。大量枚举或需要精确控制查询列时，可以直接使用 `DocumentsContract` 与 `ContentResolver`。性能取决于提供者和调用次数，尤其不应把远程文档目录当成内存中的普通列表反复遍历。[DocumentFile API](https://developer.android.com/reference/androidx/documentfile/provider/DocumentFile)

## 参考资料

- [应用专属存储](https://developer.android.com/training/data-storage/app-specific)
- [SAF 文档选择、目录限制与持久化授权](https://developer.android.com/training/data-storage/shared/documents-files)
- [Android 11 存储变化](https://developer.android.com/about/versions/11/privacy/storage)
- [Android 13 的细粒度媒体权限](https://developer.android.com/about/versions/13/behavior-changes-13#granular-media-permissions)
- [Android 14 部分照片和视频访问](https://developer.android.com/about/versions/14/changes/partial-photo-video-access)
- [DocumentFile API](https://developer.android.com/reference/androidx/documentfile/provider/DocumentFile)
