---
title: 'Bitmap 为什么吃内存：从像素预算到按需解码'
description: '用宽、高和像素格式估算 Bitmap 的成本，再通过两次读取、inSampleSize、缓存预算和生命周期，分析图片加载中的内存压力。'
date: '2026-03-08T23:34:01+08:00'
categories: [Android, 图形]
tags: [Android, Bitmap, 内存优化, Kotlin]
updated: '2026-10-15'
---

一张几百 KB 的 JPEG，解码后可能占用接近 8 MiB 内存。文件大小描述的是编码后的存储量，Bitmap 的像素缓冲区则取决于尺寸和像素格式。排查图片内存问题，第一步应看解码后的宽高，而不是网络下载了多少字节。

## 从一个像素算起

`ARGB_8888` 为每个像素的透明度、红、绿、蓝分量各分配 8 位，共 32 位，也就是 4 字节。

忽略行对齐及其他开销，像素内存可以先按下面的式子估计：

$$
M \approx W \times H \times B
$$

这里 $W$、$H$ 是解码后的像素尺寸，$B$ 是每像素字节数。三组直观的数值是：

| 尺寸 | ARGB_8888 像素字节数 | 换算 |
| --- | ---: | ---: |
| 100 × 100 | 40,000 | 约 39.1 KiB |
| 1080 × 1920 | 8,294,400 | 约 7.91 MiB |
| 4000 × 3000 | 48,000,000 | 约 45.78 MiB |

MiB 使用 $1024^2$ 字节作为单位。这个估算只覆盖一份像素数据：原图、缩放图、模糊结果和编码缓冲若同时存活，峰值会继续增加。

实际排查时还要看 `byteCount` 与 `allocationByteCount`。Bitmap 复用或重新配置后，当前像素所需字节数可能小于已经分配的缓冲区大小；API 19 起可以用 `allocationByteCount` 观察像素分配量。[Bitmap 内存 API](https://developer.android.com/reference/android/graphics/Bitmap#getAllocationByteCount())

## 文件、Bitmap、Drawable 和 ImageView

典型图片显示过程是：

```text
JPEG / PNG / WebP 字节
          ↓ 解码
Bitmap 像素数据
          ↓ 包装或交给绘制系统
Drawable / Canvas
          ↓
ImageView 等 UI 宿主
```

Bitmap 是数据；Drawable 是可绘制对象的抽象，可能包装 Bitmap，也可能表示颜色、形状或矢量路径；ImageView 则负责在界面中显示 Drawable。

Bitmap 还可以作为离屏绘制的目标，例如创建一张可修改的位图，把 Canvas 绑定到它，再画一个圆：

```kotlin
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint

/** Create a small mutable bitmap and draw a circle into its pixel buffer. */
fun createCircleBitmap(): Bitmap {
    val bitmap = Bitmap.createBitmap(500, 500, Bitmap.Config.ARGB_8888)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.RED }
    Canvas(bitmap).drawCircle(250f, 250f, 100f, paint)
    return bitmap
}
```

这里创建的 Bitmap 可修改。来自解码器或图片库的 Bitmap 可能不可修改；`HARDWARE` 配置还限制 CPU 像素访问，不能把任意 Bitmap 都当成可写画布。

## 像素格式影响空间，也影响能力

| 配置 | 典型像素成本 | 特点 |
| --- | ---: | --- |
| `ARGB_8888` | 4 字节 | 8 位通道，支持透明度 |
| `RGB_565` | 2 字节 | 无透明度，颜色精度较低 |
| `ALPHA_8` | 1 字节 | 只保存透明度信息 |
| `RGBA_F16` | 8 字节 | 更高精度，可用于宽色域、HDR 等场景 |
| `HARDWARE` | 不以固定软件像素格式概括 | 硬件位图，不可修改，适用于显示用途 |

因此，`ARGB_8888` 是常见通用选择，但不是所有场景的最高精度格式。选择 `RGB_565` 可以减少部分图片的像素内存，代价是透明度和颜色精度；选择前应根据真实图片内容判断。[Bitmap.Config](https://developer.android.com/reference/android/graphics/Bitmap.Config)

## 在解码前缩小，收益才发生在峰值之前

如果先把 4000 × 3000 原图解码，再调用缩放函数获得缩略图，原图的分配已经发生了。缩放期间还可能同时持有两份 Bitmap。

经典的 BitmapFactory 方案是读取两次：

1. 设置 `inJustDecodeBounds = true`，只读取宽、高等信息。
2. 根据目标像素尺寸计算 `inSampleSize`。
3. 重新打开输入流，按采样倍率解码。

对 4000 × 3000 图片，`inSampleSize = 4` 会得到约 1000 × 750 的像素尺寸；宽高都缩为四分之一，像素数量约为原来的十六分之一。实际输出尺寸以解码器返回值为准。

下面的例子按“采样后两边仍不小于目标尺寸”选择 2 的幂次倍率。调用方已持有 Uri 读取权限，目标宽高单位是 **px**。

```kotlin
import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Decode a sampled bitmap while retaining enough pixels for the target bounds. */
suspend fun decodeSampledBitmap(
    resolver: ContentResolver,
    uri: Uri,
    targetWidthPx: Int,
    targetHeightPx: Int
): Bitmap = withContext(Dispatchers.IO) {
    require(targetWidthPx > 0 && targetHeightPx > 0)
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }

    val boundsInput = resolver.openInputStream(uri)
        ?: throw IOException("Could not open the image")
    boundsInput.use { BitmapFactory.decodeStream(it, null, options) }
    if (options.outWidth <= 0 || options.outHeight <= 0) {
        throw IOException("Unsupported or invalid image dimensions")
    }

    var sample = 1
    while (
        options.outWidth / sample / 2 >= targetWidthPx &&
        options.outHeight / sample / 2 >= targetHeightPx
    ) {
        sample *= 2
    }
    options.inSampleSize = sample
    options.inJustDecodeBounds = false

    // The first stream has already been consumed; reopen the content for decoding.
    val pixelsInput = resolver.openInputStream(uri)
        ?: throw IOException("Could not reopen the image")
    pixelsInput.use {
        BitmapFactory.decodeStream(it, null, options)
            ?: throw IOException("Image decoding failed")
    }
}
```

`inJustDecodeBounds` 不分配完整 Bitmap 像素缓冲区，但仍需读取、解析图片信息。二次打开也很重要：ContentProvider 提供的流未必支持 `reset()` 或随机访问。

这个示例只说明采样过程。照片的 EXIF 方向、最终裁剪方式和色彩处理仍需按显示需求处理。对于极端长图，要求两边都满足目标尺寸可能保留过多像素，应改用区域解码、分块显示或适合实际缩放规则的尺寸计算。[高效加载大图](https://developer.android.com/topic/performance/graphics/load-bitmap)

## OOM、绘制上限和内存泄漏分别看什么

`OutOfMemoryError` 表示内存申请失败。`Canvas: trying to draw too large bitmap` 则可能来自绘制系统对单张图片大小的限制，不能只凭提示里有“large bitmap”就把所有失败归为 OOM。

Bitmap 像素数据所在的内存区域也随 Android 版本变化：Android 8.0 及以上，像素数据在 native heap。只观察 Java 堆中的对象数量，会漏掉重要的图片内存压力。[Bitmap 内存管理](https://developer.android.com/topic/performance/graphics/manage-memory)

排查时可以沿着三个方向收集证据：

- **单张过大**：记录解码宽高、配置和像素分配量，确认目标控件实际需要多大。
- **并发或副本过多**：观察列表预加载、图片变换与导出的同一时刻持有多少份缓冲区。
- **生命周期过长**：检查退出页面后，Bitmap 是否仍被缓存、旧 View、回调或状态对象持有。

图片列表通常交给 Coil、Glide 等图片库处理尺寸与请求生命周期更合适。应用仍需给出正确的目标尺寸，并控制额外缓存；库缓存之外再放一个无上限的 Bitmap Map，会把同一批图片长期保留下来。

`recycle()` 也不能替代所有权管理。仍在显示、被缓存或由图片库管理的 Bitmap，不能因为某个页面“暂时不用”就回收。自主管理的临时位图，只有在确认所有使用者都结束后，才适合主动释放。

当图片来自长列表或离屏 View 导出时，还要把测量布局、像素预算和输出流程串起来。这个场景可继续看 [YuukaTalk 图片导出的测绘与内存边界](/2026/03/12/project-yuukatalk-image-export/)。

## 参考资料

- [大图尺寸读取与 inSampleSize](https://developer.android.com/topic/performance/graphics/load-bitmap)
- [BitmapFactory.Options](https://developer.android.com/reference/android/graphics/BitmapFactory.Options)
- [Bitmap 分配量与像素访问 API](https://developer.android.com/reference/android/graphics/Bitmap)
- [Bitmap.Config 的能力与限制](https://developer.android.com/reference/android/graphics/Bitmap.Config)
- [不同 Android 版本的 Bitmap 内存管理](https://developer.android.com/topic/performance/graphics/manage-memory)
