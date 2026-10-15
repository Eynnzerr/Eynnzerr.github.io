---
title: '从状态到像素：理解 Compose 的重组与副作用'
description: '把 Composition、remember、Effect 和 Flow 放回同一条执行链，理解状态读在什么位置、任务由谁取消，以及哪些更新根本不需要重组。'
date: '2026-03-08T22:37:29+08:00'
categories: [Android, Compose]
tags: [Android, Jetpack Compose, Kotlin, 状态管理]
updated: '2026-10-15'
---

写 Compose 时，最容易混在一起的是三件事：保存一个值、根据这个值描述界面，以及在值变化后执行任务。它们分别对应状态、组合和副作用，生命周期也各不相同。

以一个搜索框为例：输入文字是状态，文字框和结果列表是 UI 描述，向服务端提交查询是副作用。先分清这三层，再看 `remember`、`LaunchedEffect` 和 `collectAsStateWithLifecycle`，API 就容易放到合适的位置。

## 一次状态变化如何抵达屏幕

Compose 可以用 `UI = f(State)` 概括：界面由当前状态决定。运行时会记录可观察状态在哪里被读取，值变化后让相应的工作失效，再安排更新。

这里的更新分成三个阶段：

| 阶段 | 解决的问题 | 典型工作 |
| --- | --- | --- |
| Composition | 显示什么 | 执行 composable，建立或更新 UI 描述 |
| Layout | 多大、放在哪 | 测量节点，然后放置节点 |
| Drawing | 画成什么样 | 执行绘制操作，产生画面 |

重组发生在 Composition 阶段。一次重组结束后，布局或绘制是否需要继续执行，取决于实际变化。反过来，如果状态只在绘制阶段读取，更新也可以只触发绘制。

例如，下面的颜色在 `drawBehind` 内读取：

```kotlin
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** Draw a swatch whose color is observed only during drawing. */
@Composable
fun ColorSwatch(color: State<Color>) {
    Box(
        Modifier
            .size(48.dp)
            .drawBehind { drawRect(color.value) }
    )
}
```

`color.value` 改变时，这个读取点需要重新绘制。如果把它提前读出来，再作为普通值传给布局代码，依赖就可能进入组合阶段。优化的关键因此是**状态在哪里被读取**，而不只是状态在哪里创建。[Compose phases](https://developer.android.com/develop/ui/compose/phases)

## Composition、Composer 和 Recomposer 各做什么

`Composition` 代表一次组合所维护的运行实例。`Composer` 在 composable 执行时记录调用位置、参数以及需要记住的值；`Recomposer` 负责协调失效组合的重组和变更应用。`CompositionContext` 则提供组合与父级运行环境之间的联系。

Compose 编译器插件会转换 `@Composable` 函数，插入与运行时交互的参数和调用。它不是普通的注解处理器，也不只是给函数加一个标记。

运行时需要保存两类信息：某次调用处于什么位置，以及这个位置上一次保存了什么。源码设计文档把相关结构称为 Slot Table。这解释了 `remember` 的“记住”：同一个组合位置再次执行时，运行时能够找到先前保存的结果。

```text
编译器插入 Composer 调用
            ↓
运行时记录调用位置与状态读取
            ↓
状态变化，使相关工作失效
            ↓
重组并应用变化，更新 UI 节点
            ↓
按需要执行布局与绘制
```

一个 composable 调用并不一定对应一个布局节点：它可能只计算值，也可能调用多个 UI 组件。Slot Table 与布局节点树因此也承担不同职责。内部 group 和存储细节会随运行时演进；对业务代码更稳定的规则是位置身份、key 和状态读取关系。[How Composition Works](https://github.com/androidx/androidx/blob/androidx-main/compose/runtime/design/how-compose-works.md)

## `remember` 保存的是哪个位置的值

```kotlin
var expanded by remember { mutableStateOf(false) }
```

这里有两个动作：`mutableStateOf` 创建可观察状态，`remember` 让这个状态对象在当前位置的后续重组中复用。仅有 `remember` 并不会让普通可变对象自动获得可观察性。

当该调用离开 Composition，它记住的值会被遗忘。如果输入改变后应重新计算，可以把输入作为 key：

```kotlin
val sortedNames = remember(names) { names.sorted() }
```

这适合输入变化时才需要重新执行的计算。前提是 `names` 的变化能被正确表达；原地修改一个普通可变列表，既可能没有触发重组，也可能让 key 比较看不出变化。

`rememberSaveable` 则把可保存的值接入保存状态机制，适合输入文本、选中的 tab 等轻量 UI 状态。系统恢复页面时，可以据此重建状态；真正需要长期保存的数据仍应进入数据库、文件或其他持久层。

```kotlin
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable

/** Render an input without owning its value. */
@Composable
fun NameInput(value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(value = value, onValueChange = onValueChange)
}

/** Own the editable value at the smallest shared UI boundary. */
@Composable
fun NameEditor() {
    var name by rememberSaveable { mutableStateOf("") }
    NameInput(value = name, onValueChange = { name = it })
}
```

状态向下传，事件向上传。这里无需为了一个文本框引入页面级 ViewModel；当状态参与页面业务、被多个区域共享时，再把它提升到合适的状态持有者。[State and Jetpack Compose](https://developer.android.com/develop/ui/compose/state)

## 副作用应该跟随哪段生命周期

composable 函数体用于描述 UI，执行可能重复，也可能被跳过或中止。在函数体中直接发送网络请求，会把任务次数绑定到重组次数。

选择 Effect 时，可以先确定两个问题：任务由什么事件启动，以及什么条件下应该结束。

| API | 启动或执行时机 | 适合的工作 |
| --- | --- | --- |
| `LaunchedEffect(key)` | 进入组合时启动；key 改变时取消旧协程并重新启动 | 与当前参数绑定的挂起任务 |
| `rememberCoroutineScope()` | 返回作用域，由事件回调主动 `launch` | 点击后显示 Snackbar、滚动列表 |
| `DisposableEffect(key)` | 建立资源，并在 key 改变或离开组合时清理 | 注册监听器与对应的注销 |
| `SideEffect` | 成功提交组合后执行 | 将当前状态同步给外部对象 |
| `produceState` | 启动生产者，将结果写入 `State` | 将异步数据源接入 Compose |

`LaunchedEffect(Unit)` 的任务持续到该调用离开组合；它不是整个应用“只执行一次”的开关。key 应当表达任务身份，例如用户 ID 改变意味着重新加载对应用户。

另一个常见情况是：任务不应重启，但任务结束时必须使用最新回调。这时可以用 `rememberUpdatedState`：

```kotlin
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import kotlinx.coroutines.delay

/** Wait once per composition lifetime, then invoke the latest callback. */
@Composable
fun DelayedAction(onTimeout: () -> Unit) {
    val latestOnTimeout by rememberUpdatedState(onTimeout)
    LaunchedEffect(Unit) {
        delay(2_000)
        latestOnTimeout()
    }
}
```

外部重组更新 `onTimeout` 时，倒计时继续；两秒后调用的是最新回调。离开组合时，等待协程被取消。对于监听器，同样要让注册和清理成对出现；`DisposableEffect` 的 `onDispose` 就负责表达这段资源生命周期。[Side-effects in Compose](https://developer.android.com/develop/ui/compose/side-effects)

## State 与 Flow：三个方向不能混用

`collectAsStateWithLifecycle` 把 Flow 的值带入 Android Compose UI，并按 Lifecycle 决定何时收集。`snapshotFlow` 把 Compose snapshot state 的读取结果变成 Flow。`derivedStateOf` 则仍然留在 Compose 的 State 世界内。

列表滚动是个很好的例子。列表位置变化频繁，但“回到顶部”按钮可能只关心是否已经离开第一项：

```kotlin
val listState = rememberLazyListState()
val showBackToTop by remember {
    derivedStateOf { listState.firstVisibleItemIndex > 0 }
}
```

索引从 1 变为 2、3 时，派生结果仍然是 `true`。这个派生状态可以避免仅依赖该布尔值的 UI 为每次索引变化而重组。它不抑制其他依赖引起的重组。

`derivedStateOf` 自身有开销。只有输入变化比 UI 需要的结果变化更频繁时，这个中间层才有意义。名字拼接、输入变化后执行一次排序等问题，通常直接计算或使用带 key 的 `remember` 更合适。

如果希望把滚动位置交给协程流处理，可以写成：

```kotlin
LaunchedEffect(listState) {
    snapshotFlow { listState.firstVisibleItemIndex }
        .collect { index ->
            // Forward the observed index to the surrounding application logic.
        }
}
```

这个片段放在拥有 `listState` 的 composable 内；`snapshotFlow` 的读取块保持无副作用，真正的处理放到收集端。与之相反，ViewModel 的 `StateFlow` 进入 UI 时，常见写法是 `val uiState by viewModel.uiState.collectAsStateWithLifecycle()`。

## 嵌套成本与 View 混编

Compose 中的函数层次不直接等于 Android View 层次。`Modifier` 也能表达一部分原本需要包装 View 才能完成的布局、绘制和输入行为。常规 Compose 布局采用单次测量约束，减少了重复测量嵌套子树的机会。

布局节点、绘制和重组仍有成本。判断性能问题时，应区分是组合工作过多、布局重复，还是图片与绘制过重，再针对具体阶段处理。

在传统 View 中嵌入 Compose 时，常用入口是 `ComposeView`，它继承自 `AbstractComposeView`，以 ViewGroup 宿主承载组合。Fragment 中还需要让组合释放策略与 Fragment 的 **View 生命周期**对应，例如 `DisposeOnViewTreeLifecycleDestroyed`；仅仅“能放进 View 树”还不足以说明生命周期已经接对。[Using Compose in Views](https://developer.android.com/develop/ui/compose/migrate/interoperability-apis/compose-in-views)

## 参考资料

- [Compose 的三个阶段与状态读取](https://developer.android.com/develop/ui/compose/phases)
- [状态、remember 与状态提升](https://developer.android.com/develop/ui/compose/state)
- [Effect API、derivedStateOf 与 snapshotFlow](https://developer.android.com/develop/ui/compose/side-effects)
- [AndroidX：How Composition Works](https://github.com/androidx/androidx/blob/androidx-main/compose/runtime/design/how-compose-works.md)
- [在 View 中使用 Compose 与释放策略](https://developer.android.com/develop/ui/compose/migrate/interoperability-apis/compose-in-views)
