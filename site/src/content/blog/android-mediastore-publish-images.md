---
title: '用 MediaStore 保存图片：从创建媒体项到正式发布'
description: '以 Android 10 及以上的图片导出为例，说明 MediaStore 的 Uri、RELATIVE_PATH、IS_PENDING，以及写入成功、失败和读取授权之间的关系。'
date: '2026-03-06T15:48:12+08:00'
categories: [Android, 存储]
tags: [Android, MediaStore, Bitmap, Scoped Storage]
updated: '2026-10-15'
---

应用生成了一张图片，用户点击“保存到相册”。这件事包含两步：写出图片数据，以及让系统媒体库拥有一条可发现、可管理的媒体记录。MediaStore 把这两个步骤组织在同一个内容访问模型中。

本文以 Android 10（API 29）及以上为范围，展示应用创建自己的共享图片。读取或修改其他应用创建的媒体，是另一组权限问题。

## MediaStore 管理的是媒体项

MediaStore 提供图片、视频和音频等集合。调用方通过 `ContentResolver` 查询集合、插入记录，再使用单条记录对应的 Uri 读写内容。

```text
MediaStore.Images 集合
        ↓ insert(ContentValues)
新图片的 content Uri
        ↓ openOutputStream(uri)
写入经过编码的图片字节
        ↓ 完成发布
其他具有访问权的应用可以发现这张图片
```

`DISPLAY_NAME` 是显示名称，`MIME_TYPE` 描述内容类型，`RELATIVE_PATH` 给出公共存储中的相对位置。它们是媒体项的元数据，不需要调用方先拼出一个绝对文件路径。

MediaStore 适合系统会统一索引和展示的媒体。用户选择任意 PDF、ZIP，或指定一个文档导出位置时，更适合 [SAF](/2026/03/06/android-storage-uri-saf/)。

## 为什么要有 `IS_PENDING`

插入一条记录时，图片字节可能还没写完。如果立刻对其他应用可见，它们就可能读到不完整文件。

Android 10 引入的 `IS_PENDING` 可以表达这个中间状态：创建时设置为 1，由创建者写入；数据完成后更新为 0，将媒体项发布出去。写入失败则删除未完成的记录。[共享媒体与 pending 状态](https://developer.android.com/training/data-storage/shared/media#toggle-pending-status)

这使一次保存操作具有清楚的阶段：

| 阶段 | 数据与记录状态 |
| --- | --- |
| 插入成功 | 已获得 Uri，记录仍为 pending |
| 写入中 | 向 Uri 对应的输出流编码图片 |
| 写入与关闭成功 | 可以清除 pending 状态 |
| 写入失败 | 清理本次创建的记录，并向调用方报告失败 |

## 一个完整的 PNG 保存函数

下面的函数接收已经准备好的 Bitmap，保存到 `Pictures/MyApp`。调用点只在 API 29 及以上使用它；`@RequiresApi` 表达这一条件，不负责运行时版本判断。

```kotlin
import android.content.ContentResolver
import android.content.ContentValues
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Publish a Bitmap as PNG in shared storage on Android 10 or later. */
@RequiresApi(Build.VERSION_CODES.Q)
suspend fun savePngToGallery(
    resolver: ContentResolver,
    bitmap: Bitmap,
    displayName: String
): Uri = withContext(Dispatchers.IO) {
    val collection = MediaStore.Images.Media.getContentUri(
        MediaStore.VOLUME_EXTERNAL_PRIMARY
    )
    val metadata = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
        put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        put(
            MediaStore.Images.Media.RELATIVE_PATH,
            "${Environment.DIRECTORY_PICTURES}/MyApp"
        )
        put(MediaStore.Images.Media.IS_PENDING, 1)
    }
    val uri = resolver.insert(collection, metadata)
        ?: throw IOException("Could not create the image entry")

    try {
        val output = resolver.openOutputStream(uri, "w")
            ?: throw IOException("Could not open the image output")
        output.use { stream ->
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) {
                throw IOException("PNG encoding failed")
            }
        }

        val published = ContentValues().apply {
            put(MediaStore.Images.Media.IS_PENDING, 0)
        }
        if (resolver.update(uri, published, null, null) != 1) {
            throw IOException("Could not publish the image entry")
        }
        uri
    } catch (error: Exception) {
        // Keep the original failure if cleanup also fails.
        runCatching { resolver.delete(uri, null, null) }
        throw error
    }
}
```

调用时使用带 `.png` 后缀的文件名，例如 `poster.png`。这里写出的实际编码、MIME 类型和文件名应保持一致。PNG 是无损格式，`quality = 100` 这个参数不会像 JPEG 一样控制有损压缩质量。

函数把编码与内容提供者 I/O 放在 `Dispatchers.IO` 中。Bitmap 的生成或复杂图像变换也可能耗时，应另行安排，避免在主线程完成后才调用这个保存函数。

代码中的清理覆盖函数能够捕获的失败。若进程在写入中直接结束，`catch` 不会运行；对需要可靠恢复的长时间导出任务，可以保存本次 Uri，并在下次启动时处理遗留的 pending 项。

## “保存自己的图片”与“浏览全部图片”权限不同

在 Android 10 及以上，应用通过 MediaStore 添加自己创建的媒体，不需要为了这次新增操作申请存储权限。读取其他应用创建的媒体，则要按系统版本、targetSdk 和当前授权处理。

例如，面向 Android 13 及以上目标版本的媒体库应用，需要相应的 `READ_MEDIA_*` 权限；照片与视频还要处理 Android 14 的部分授权。如果功能只是“选一张头像”，Photo Picker 直接让用户选择具体内容，更接近所需的访问范围。

同样，修改、删除其他应用创建的媒体可能需要用户确认。已经知道一条 Uri，只说明能够标识该媒体项，并不自动拥有修改权。[MediaStore 访问与权限](https://developer.android.com/training/data-storage/shared/media)

## 从查询结果构造单条媒体 Uri

查询集合通常得到 `_ID`、名称和尺寸等字段。可以将 `_ID` 附加到查询使用的 collection Uri，构造单条媒体地址，然后通过 `ContentResolver` 打开它。

```kotlin
import android.content.ContentUris

// collection is the MediaStore collection used for the query.
// id is the _ID value read from the current Cursor row.
val itemUri = ContentUris.withAppendedId(collection, id)
```

这个片段位于已有 Cursor 的处理逻辑中。查询时只请求需要的列，并用 `use` 关闭 Cursor。不要把 `_DATA` 当成必然可读、可长期使用的绝对路径；Uri 才是后续打开内容和执行更新时应保存的标识。

当共享媒体需要交给别的应用查看时，还需要通过 Intent 的临时授权表达访问权，例如读权限 flag。媒体库中的记录、当前应用拥有的权限，以及接收方获得的权限，分别属于不同的环节。

## 参考资料

- [MediaStore：访问、插入、pending 状态与媒体修改](https://developer.android.com/training/data-storage/shared/media)
- [MediaStore API](https://developer.android.com/reference/android/provider/MediaStore)
- [Bitmap.compress：格式与 quality 的语义](https://developer.android.com/reference/android/graphics/Bitmap#compress(android.graphics.Bitmap.CompressFormat,int,java.io.OutputStream))
- [Android 13 媒体权限](https://developer.android.com/about/versions/13/behavior-changes-13#granular-media-permissions)
- [Android 14 部分照片和视频访问](https://developer.android.com/about/versions/14/changes/partial-photo-video-access)
- [Photo Picker](https://developer.android.com/training/data-storage/shared/photo-picker)
