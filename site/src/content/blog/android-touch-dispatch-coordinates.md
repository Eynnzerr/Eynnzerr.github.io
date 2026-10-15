---
title: 'Android 触摸事件：先确定坐标，再理解分发与拦截'
description: '用一段从 DOWN 到 CANCEL 的手势说明触摸目标如何建立、父容器何时接管，以及局部坐标、屏幕坐标和多指 pointerId 为什么不能混用。'
date: '2026-03-02T16:32:41+08:00'
categories: [Android, View]
tags: [Android, View, MotionEvent, 事件分发]
updated: '2026-10-15'
---

一个按钮放在可横向滑动的父容器里：手指按下时，按钮应该显示按压效果；手指明显横移后，父容器应该接管滚动；松手时，按钮不能再触发点击。

这段交互同时涉及坐标、手势识别和事件分发。先看每个值相对于谁，再看一段手势如何转交，比只背三个方法的返回值更容易解释实际行为。

## View 位置与触摸位置是两组坐标

View 的 `left`、`top`、`right`、`bottom` 是父容器为它确定的布局边界。平移属性会改变显示位置，但不直接重写这些布局边界：

```text
x = left + translationX
y = top  + translationY
```

比如 `left = 100`、`translationX = 20`，那么 `x = 120`。之后父容器重新布局，`left` 仍可能变化；它不是创建后永远固定的值。

MotionEvent 的 `getX()`、`getY()` 则是事件接收 View 的局部坐标。事件传给子 View 时，框架会处理相应的坐标转换，所以父容器和子 View 观察到的同一次触摸坐标可以不同。

| 数值 | 所属参照系 |
| --- | --- |
| `View.left/top` | 父容器中的布局位置 |
| `View.x/y` | 布局位置加上平移 |
| `MotionEvent.x/y` | 当前接收 View 的局部坐标 |
| `MotionEvent.rawX/rawY` | 显示设备坐标系中的位置 |
| `getLocationInWindow()` | View 在窗口中的位置 |
| `getLocationOnScreen()` | View 在屏幕中的位置 |

窗口偏移、分屏和变换都会影响坐标转换。计算滑动距离时，应让起点和当前点使用同一参照系，不能用 `rawX` 减去局部 `downX`。

`scrollX/scrollY` 表示 View 内容的滚动偏移，与移动 View 自身的 `translationX/translationY` 也有不同作用。[MotionEvent API](https://developer.android.com/reference/android/view/MotionEvent)

## 三个方法各负责哪一段

触摸事件经过系统输入分发与窗口处理后，进入应用的 View 层次。应用层常见的调用关系可以简化为：

```text
Activity.dispatchTouchEvent
          ↓
窗口中的 ViewGroup.dispatchTouchEvent
          ↓
子 View.dispatchTouchEvent
          ↓
OnTouchListener / onTouchEvent
```

其中：

| 方法 | 职责 |
| --- | --- |
| `dispatchTouchEvent()` | 组织当前事件的分发，并返回是否处理 |
| `ViewGroup.onInterceptTouchEvent()` | 判断是否由父容器接管原本可能交给子 View 的事件 |
| `onTouchEvent()` | 执行当前 View 的触摸处理逻辑 |

普通叶子 View 没有 `onInterceptTouchEvent()`。这个接口属于 ViewGroup，因为只有它需要决定是否继续向子节点分发。

在满足 View 的可用状态等条件时，`OnTouchListener.onTouch()` 会先于 View 自己的 `onTouchEvent()` 处理；监听器返回 true，会使后者不再处理这次事件。点击通常由默认触摸逻辑中的有效按下、抬起序列触发，不能把 `onClick` 简化成每个 `ACTION_UP` 都执行。

## DOWN 建立的是后续触摸目标

一次常规单指手势从 `ACTION_DOWN` 开始，经历若干 `ACTION_MOVE`，最终以 `ACTION_UP` 或 `ACTION_CANCEL` 结束。MOVE 的数量可以为零。

DOWN 阶段，父容器检查能够接收触摸的子 View。某个子 View 的分发返回 true 后，父容器会记录相应触摸目标，后续事件通常沿着这条关系继续交付。

```text
DOWN：寻找能处理的子 View，并建立目标
MOVE：继续交给已有目标，或由父容器改为拦截
UP：目标完成本次手势
CANCEL：目标放弃本次手势，并清除按压、拖动等状态
```

如果一个子 View 没有处理 DOWN，它通常不会成为后续 MOVE、UP 的接收目标。已有目标接收到 MOVE 后返回 false，也不意味着框架会重新命中测试所有兄弟 View。常见的“先向下询问，再向上回溯”图适合理解初始分发，后续还必须考虑父容器保存的目标关系。[AOSP ViewGroup.dispatchTouchEvent](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/view/ViewGroup.java)

## 父容器在 MOVE 中接管时发生什么

回到按钮与横向容器的例子：

| 时刻 | 父容器 | 子按钮 |
| --- | --- | --- |
| DOWN | 暂不拦截，记录起点 | 接收 DOWN，进入按压状态 |
| 小幅 MOVE | 位移未超过阈值，继续分发 | 保持当前手势 |
| 明显横向 MOVE | 决定拦截，终止原触摸目标 | 收到 CANCEL，清除按压，不执行点击 |
| 后续 MOVE、UP | 按父容器自己的手势逻辑处理 | 不再接收这段手势的普通事件 |

所以 CANCEL 应当和 UP 一样，具有明确的收尾路径。对于拖动，UP 可以提交位置，CANCEL 则结束跟踪并取消点击语义；两者都需要释放临时状态。

父容器也可以在 DOWN 直接拦截。只是对于“先允许按钮点击，滑动后再接管”的交互，通常先让子 View 建立目标，然后根据移动方向和阈值判断。[ViewGroup 触摸管理](https://developer.android.com/develop/ui/views/touch-and-input/gestures/viewgroup)

## 用 touch slop 区分手抖与滑动

手指很难在按下和抬起之间保持完全静止。`ViewConfiguration.get(context).scaledTouchSlop` 提供与设备配置相关的距离阈值。

下面的纯判断函数使用同一局部坐标系中的起点和当前点，判断横向移动是否足以接管：

```kotlin
import kotlin.math.abs

/** Detect horizontal intent using positions measured in the same coordinate space. */
fun shouldStartHorizontalDrag(
    downX: Float,
    downY: Float,
    currentX: Float,
    currentY: Float,
    touchSlop: Int
): Boolean {
    val dx = abs(currentX - downX)
    val dy = abs(currentY - downY)
    return dx > touchSlop && dx > dy
}
```

父容器在 DOWN 记录起点，在 MOVE 调用这个判断。一旦决定接管，就在本次手势中保持自己的拖动状态，并在 UP/CANCEL 清理。这个函数只负责方向与阈值判断，滚动距离、边界和速度由容器自己的手势实现处理。

子 View 也可以调用 `requestDisallowInterceptTouchEvent(true)`，请求祖先暂时不要拦截当前手势；需要把控制权交回去时再传 false。新手势开始时，这个状态会被重置，所以它不是永久改变父容器的设置。

当父子双方都需要参与连续滚动时，Nested Scrolling 等协作机制通常比反复抢占整段事件更合适；二者的区别在于“共同消费滚动距离”和“改变触摸事件的接收者”。

## 多指时，跟踪 pointerId，不缓存 pointerIndex

一个 MotionEvent 可以包含多个触点。`pointerId` 标识同一段手势中的某根手指，`pointerIndex` 是这根手指在当前事件数组中的位置。

考虑这段变化：

| 事件 | 当前数组中的触点 |
| --- | --- |
| 第一根手指 DOWN | index 0 → id 4 |
| 第二根手指 POINTER_DOWN | index 0 → id 4，index 1 → id 9 |
| 第一根手指 POINTER_UP | 本次事件仍能识别离开的 id 4 |
| 下一次 MOVE | index 0 → id 9 |

如果一直读取 index 0，观察对象就从第一根手指变成了第二根。应保存正在跟踪的 ID，在每次事件到来时查找当前 index：

```kotlin
import android.graphics.PointF
import android.view.MotionEvent

/** Resolve the current local position of a previously selected pointer ID. */
fun pointerPosition(event: MotionEvent, activePointerId: Int): PointF? {
    val index = event.findPointerIndex(activePointerId)
    if (index < 0) return null
    return PointF(event.getX(index), event.getY(index))
}
```

处理 `ACTION_POINTER_DOWN` 和 `ACTION_POINTER_UP` 时，用 `actionMasked` 判断动作，用 `actionIndex` 找到这次加入或离开的触点。如果离开的是当前跟踪的手指，应明确选择另一根手指并重设基准，或者结束本次拖动。否则，即便 ID 使用正确，也可能因为基准没有更新而产生位置跳跃。[多指手势](https://developer.android.com/develop/ui/views/touch-and-input/gestures/multi)

## 自定义点击还要保留点击语义

在 `onTouchEvent()` 中完全接管事件后，如果识别出了点击，应通过 `performClick()` 进入点击路径。这样点击监听器、辅助功能等机制才能得到一致的信号，而不是只在触摸抬起时私自执行一段业务代码。

排查触摸问题时，可以记录事件类型、接收 View、局部坐标和目标 pointerId，沿同一段手势观察。坐标参照系正确、DOWN 建立目标、MOVE 明确接管、UP/CANCEL 正确收尾，这四段对上以后，大多数“点不到”“滑动时误点击”和“多指跳动”都会变成可定位的状态变化。

## 参考资料

- [ViewGroup 中的触摸管理与 touch slop](https://developer.android.com/develop/ui/views/touch-and-input/gestures/viewgroup)
- [多指触摸的 ID、index 与事件处理](https://developer.android.com/develop/ui/views/touch-and-input/gestures/multi)
- [MotionEvent 坐标与动作 API](https://developer.android.com/reference/android/view/MotionEvent)
- [AOSP ViewGroup：触摸目标、拦截与 CANCEL](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/view/ViewGroup.java)
- [AOSP View：属性坐标与触摸处理](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/view/View.java)
