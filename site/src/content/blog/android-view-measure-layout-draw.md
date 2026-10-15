---
title: 'View 的三大流程：把测量约束、布局坐标和绘制分开'
description: '从 ViewRootImpl 的遍历调度出发，解释 MeasureSpec、LayoutParams、测量尺寸与实际尺寸，并实现正确处理 wrap_content 的圆形 View。'
date: '2026-03-04T13:51:32+08:00'
categories: [Android, View]
tags: [Android, View, 自定义控件, 绘制]
updated: '2026-10-15'
---

自定义 View 的三个基本问题分别是：我需要多大、父容器把我放在哪里、我应该画什么。它们对应 measure、layout 和 draw。

三者的数据流是连续的：测量给出尺寸，布局给出边界，绘制消费这些结果。把这条链拆开，`wrap_content` 为什么填满父容器、`onCreate()` 为什么拿不到最终宽高、改颜色为什么只需重绘，都有了具体解释。

## 从一次布局请求到遍历

View 树连接到窗口后，由 `ViewRootImpl` 协调遍历。一次布局请求可以沿父链传到根部，再安排后续帧的 traversal：

```text
requestLayout()
      ↓
ViewRootImpl.scheduleTraversals()
      ↓ 帧调度
performTraversals()
      ├─ 按需要 measure
      ├─ 按需要 layout
      └─ 按需要 draw
```

`requestLayout()` 表达需要重新考虑布局，不意味着调用返回前已经完成所有测量；同一帧的请求可以被合并。`performTraversals()` 也会根据状态决定哪些工作需要执行。分析源码时，应该沿“请求 → 调度 → 实际遍历”观察，而不是把每个方法名都视为立即执行完整流程。[ViewRootImpl 源码](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/view/ViewRootImpl.java)

## MeasureSpec 是父容器交给子 View 的约束

子 View 的 LayoutParams 表达需求，父容器根据自己的约束、padding、margin 及布局规则，生成传给子 View 的 MeasureSpec。

MeasureSpec 用一个整数编码 mode 与 size。mode 有三种：

| 模式 | 子 View 应如何理解 |
| --- | --- |
| `EXACTLY` | 使用父容器给定的尺寸 |
| `AT_MOST` | 选择一个不超过给定上限的尺寸 |
| `UNSPECIFIED` | 父容器未在这一维设置尺寸上限，由子 View 计算需求 |

`match_parent`、`wrap_content` 是 LayoutParams 中的值，不是 MeasureSpec 模式的别名。它们最终转换成什么约束，要看父容器。

下面列出 `ViewGroup.getChildMeasureSpec()` 的典型关系。表中“剩余空间”是父容器扣除相应占用之后传给计算函数的大小；实际布局容器还可以增加自己的测量规则。

| 父模式 | 子布局参数 | 常见子约束 |
| --- | --- | --- |
| `EXACTLY` | 固定 px | `EXACTLY`，固定尺寸 |
| `EXACTLY` | `match_parent` | `EXACTLY`，剩余空间 |
| `EXACTLY` | `wrap_content` | `AT_MOST`，剩余空间 |
| `AT_MOST` | 固定 px | `EXACTLY`，固定尺寸 |
| `AT_MOST` | `match_parent` | `AT_MOST`，剩余空间 |
| `AT_MOST` | `wrap_content` | `AT_MOST`，剩余空间 |
| `UNSPECIFIED` | 固定 px | `EXACTLY`，固定尺寸 |
| `UNSPECIFIED` | `match_parent` / `wrap_content` | `UNSPECIFIED`，不把 size 当作上限 |

固定尺寸通常由资源或布局系统从 dp 转成 px。`MeasureSpec.getSize()` 返回的也是像素值。

父 ViewGroup 可以先测子 View，再综合结果决定自身尺寸，也可能按自己的算法重复测量某些子 View。因此“所有容器都只递归测量一次”并不是 View 测量协议的保证。[View.MeasureSpec](https://developer.android.com/reference/android/view/View.MeasureSpec)、[ViewGroup.getChildMeasureSpec](https://developer.android.com/reference/android/view/ViewGroup#getChildMeasureSpec(int,int,int))

## 为什么默认 `wrap_content` 可能太大

直接继承 View 时，默认 `onMeasure()` 会使用 `getDefaultSize()`。在 `AT_MOST` 情况下，它可以直接采用父级给出的 size，而不会替自定义内容计算理想尺寸。

一个只想画 80dp 圆形的 View，如果没有实现自己的测量规则，就可能占据远大于圆本身的空间。自定义测量需要先确定内容希望多大，加上 padding，再满足父容器的约束。

尤其要单独考虑 `UNSPECIFIED`：不能对所有非 `EXACTLY` 分支都执行 `min(desiredSize, specSize)`。在未设上限的情况下，size 可能是 0，这样反而会把内容压成零尺寸。

`resolveSizeAndState()` 已经表达了这套尺寸约束关系，可以用它完成普通自定义 View 的测量。

## 一个完整的 CircleView

这个 View 在宽松约束下希望拥有 80dp 的内容尺寸；父级给出精确大小时服从父级；绘制时在扣除 padding 的区域中画圆。

```kotlin
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Draw a circle while reporting a useful intrinsic content size. */
class CircleView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {
    /** Reuse the paint across frames instead of allocating in onDraw. */
    private val circlePaint = Paint(Paint.ANTI_ALIAS_FLAG)

    /** Fill color; changing it invalidates pixels without changing geometry. */
    var circleColor: Int = Color.RED
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }

    /** Combine the preferred content size with padding and parent constraints. */
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val diameter = (80f * resources.displayMetrics.density).roundToInt()
        val desiredWidth = max(
            suggestedMinimumWidth,
            diameter + paddingLeft + paddingRight
        )
        val desiredHeight = max(
            suggestedMinimumHeight,
            diameter + paddingTop + paddingBottom
        )
        setMeasuredDimension(
            resolveSizeAndState(desiredWidth, widthMeasureSpec, 0),
            resolveSizeAndState(desiredHeight, heightMeasureSpec, 0)
        )
    }

    /** Draw within the content rectangle determined by layout. */
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val contentWidth = (width - paddingLeft - paddingRight).coerceAtLeast(0)
        val contentHeight = (height - paddingTop - paddingBottom).coerceAtLeast(0)
        val centerX = paddingLeft + contentWidth / 2f
        val centerY = paddingTop + contentHeight / 2f
        circlePaint.color = circleColor
        canvas.drawCircle(
            centerX,
            centerY,
            min(contentWidth, contentHeight) / 2f,
            circlePaint
        )
    }
}
```

`onMeasure()` 必须通过 `setMeasuredDimension()` 保存测量结果。`onDraw()` 使用的则是布局后 `width` 和 `height`，因为那才是父容器最终分配的边界。

这里只有填充颜色可变，所以 setter 调用 `invalidate()` 即可。如果以后开放“期望直径”属性，变化会影响理想尺寸，就需要请求重新布局。[自定义绘制与尺寸](https://developer.android.com/develop/ui/views/layout/custom-views/custom-drawing)

## Layout：父容器决定子 View 的边界

测量结束后，父容器根据自己的规则调用子 View 的 `layout(left, top, right, bottom)`。例如纵向排列时，后一个子 View 的 top 来自前一个子 View 的 bottom，再加上相关间距。

这些值相对于父容器的坐标系：

```text
width  = right - left
height = bottom - top
```

`measuredWidth` 表示测量结果；`width` 表示最终布局边界的宽度。普通布局中二者经常相等，但定义不同。自定义容器应在 `onLayout()` 安排子 View；自定义叶子 View 通常无需重写 `layout()` 去修改父级给出的边界。

在 Activity 的 `onCreate()` 中，View 可能还没走完测量和布局，所以最终尺寸尚不可用。需要布局结果时，应使用布局完成回调，例如 AndroidX 的 `doOnLayout`，而不是假定某个生命周期方法之后一定已经有宽高。

## Draw：绘制内容也有层次

普通 View 的绘制可以按以下主要层次理解：背景、自身内容、子 View、前景和装饰。自定义内容一般放在 `onDraw()`，ViewGroup 的子节点绘制由 `dispatchDraw()` 参与完成。

硬件加速路径还会涉及 RenderNode、显示列表和渲染线程；Java 层 `draw()` 并不意味着每次都立刻逐像素写入屏幕。对自定义 View 而言，先保证绘制内容只依赖当前数据与已确定的边界，并减少绘制期间的分配和阻塞工作。

| 变化 | 通常需要表达的请求 |
| --- | --- |
| 内容理想尺寸变化 | `requestLayout()` |
| 在既定边界内换颜色或图形 | `invalidate()` |
| 动画逐帧刷新 | 根据变化使用属性动画或 `postInvalidateOnAnimation()` 等帧同步入口 |

这些方法表达的是后续需要做什么；框架会合并请求并跳过能够复用的工作。

## UI 线程约束属于整个 View 状态模型

View 保存测量尺寸、布局边界、父子关系和绘制状态。它们不是为多个线程同时修改设计的，所以常规应用在主线程更新 View，将耗时计算与 I/O 移到后台，再把结果交回 UI。

`ViewRootImpl.checkThread()` 是其中一道检查，它比较当前线程与创建该 ViewRootImpl 的线程。某次调用没有立即抛异常，只能说明这次执行路径未触发相应检查；异步任务与窗口附着之间还存在时序差异。

`postInvalidate()` 可以从其他线程请求刷新，但它不会让此前对子 View 字段的任意写入自动变得线程安全。Surface 的专用渲染路径也有自己的同步与生命周期约定，应与操作普通 View 层次分开理解。[进程与线程](https://developer.android.com/guide/components/processes-and-threads)

## 参考资料

- [View.MeasureSpec API](https://developer.android.com/reference/android/view/View.MeasureSpec)
- [ViewGroup.getChildMeasureSpec API](https://developer.android.com/reference/android/view/ViewGroup#getChildMeasureSpec(int,int,int))
- [自定义 View 的尺寸与绘制](https://developer.android.com/develop/ui/views/layout/custom-views/custom-drawing)
- [AOSP ViewRootImpl：遍历调度与线程检查](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/view/ViewRootImpl.java)
- [AOSP View：measure、layout 与 draw](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/view/View.java)
- [Android UI 线程模型](https://developer.android.com/guide/components/processes-and-threads)
