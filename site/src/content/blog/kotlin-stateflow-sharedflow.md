---
title: 'StateFlow 与 SharedFlow：从当前状态到广播缓冲'
description: '用订阅时机和消费速度理解 StateFlow、SharedFlow 的区别，说明 replay、额外缓冲、原子更新与 Android 生命周期的实际含义。'
date: '2026-02-28T21:26:31+08:00'
categories: ['Kotlin', '协程']
tags: ['Kotlin', 'Flow', 'StateFlow', 'SharedFlow']
updated: '2026-10-15'
---

选择 `StateFlow` 还是 `SharedFlow`，先确定后来加入的订阅者需要什么：是界面此刻的完整状态，还是最近发生的若干次事件。接着再决定，当订阅者处理得太慢、甚至暂时不存在时，数据应该留下还是丢掉。

这两个问题比“状态用 StateFlow，事件用 SharedFlow”更具体，也直接决定代码是否符合业务语义。

## 从冷流开始区分

`flow { ... }` 创建的典型冷流，会为每次收集执行一次生产逻辑：

```kotlin
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking

/** Collects the same cold flow twice. */
fun main() = runBlocking {
    val numbers = flow {
        println("生产一次")
        emit(7)
        emit(8)
    }
    println(numbers.toList())
    println(numbers.toList())
}
```

这里会生产两次。若块中执行网络请求，两次独立收集也可能发起两次请求。

`StateFlow` 和 `SharedFlow` 的实例则独立于某一个 collector 存在。多个 collector 订阅同一个实例，分享它保存的状态或广播的数据。它们不会正常结束，因此直接对一个持续存在的热流调用 `toList()`，通常会一直等待；需要有限结果时，可以先用 `take(n)` 截取。

## StateFlow 保存一个当前值

`StateFlow` 必须有初始值，通过 `value` 随时可读。新订阅者获得当前值；慢订阅者可以跳过中间变化，跟上最新状态。

它的合并依据是 `equals`。例如进度从 `20` 很快变到 `21`、`22`，界面可能只来得及处理 `20` 和 `22`；再次赋值 `22` 也不会产生新的通知。这适合“界面现在应该显示什么”，不适合记录每一步都必须保留的审计日志。

下面的模型对外暴露只读状态，内部用不可变对象更新：

```kotlin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Immutable snapshot of a fixed-size download batch. */
data class DownloadState(
    /** Number of finished downloads. */
    val completed: Int = 0,
    /** Fixed size of this batch. */
    val total: Int = 4,
)

/** Own the mutable state while exposing a read-only stream. */
class DownloadProgress {
    /** Mutable state owned by this progress tracker. */
    private val mutableState = MutableStateFlow(DownloadState())
    /** Current state exposed to observers. */
    val state = mutableState.asStateFlow()

    /** Atomically record one completed item. */
    fun completeOne() {
        mutableState.update { old ->
            old.copy(completed = (old.completed + 1).coerceAtMost(old.total))
        }
    }
}
```

`value` 的单次读写是线程安全的，但“先读取、加一、再写回”仍然是多个步骤。两个并发调用若都读到 `completed = 1`，可能都写回 `2`，丢掉一次更新。`update` 把基于旧值的修改组织成原子更新；竞争时 lambda 可能执行多次，因此更新函数只计算新状态，请求、计费等副作用放在它的外部。

状态中的集合也应当按快照处理。把 `MutableList` 放进去后原地 `add`，既破坏旧快照，也可能因为对象仍与自身相等而没有通知。通常应产生新的列表，再通过 `copy` 替换状态。

## SharedFlow 的三个参数分别服务谁

```kotlin
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow

MutableSharedFlow<String>(
    replay = 1,
    extraBufferCapacity = 2,
    onBufferOverflow = BufferOverflow.SUSPEND,
)
```

| 参数 | 对应的问题 |
| --- | --- |
| `replay` | 新订阅者到来时，补发最近多少个值？ |
| `extraBufferCapacity` | 当前慢订阅者落后时，允许额外缓存多少个值？ |
| `onBufferOverflow` | 已有订阅者跟不上，缓冲又满时，如何处理？ |

有订阅者时，缓冲容量由 `replay + extraBufferCapacity` 共同提供。后来者能补看的仍只有 replay 部分，额外缓冲并没有变成历史记录。

例如一个 collector 已订阅但暂停处理，生产者接连发出几条更新。缓冲可以暂时吸收差距；差距超过容量后，`SUSPEND` 让 `emit` 等待，`DROP_OLDEST` 腾出较旧值的位置，`DROP_LATEST` 放弃本次新值。后两种策略要求配置正的 replay 或额外容量。

`emit` 等待的是广播交付与缓冲条件。若生产者还需要订阅者“保存完成”的确认，应另行设计业务应答。

## 无订阅者时，额外缓冲不会替你保存事件

这是最容易与普通队列混淆的地方。没有订阅者时，只保存 replay 指定的历史；`extraBufferCapacity` 不承担离线存储，发射者也不会因为 `SUSPEND` 策略等待未来的订阅者。

```kotlin
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking

/** Compares an unobserved transient event with replayed state. */
fun main() = runBlocking {
    val transient = MutableSharedFlow<String>(extraBufferCapacity = 1)
    println(transient.tryEmit("saved")) // true，但此时没有订阅者，值不会留下
    println(transient.replayCache)     // []

    val recent = MutableSharedFlow<String>(replay = 1)
    recent.emit("connected")
    println(recent.first())            // connected
}
```

`tryEmit()` 返回 `true`，表示这次尝试不需要挂起即可完成。默认 `MutableSharedFlow()` 没有缓冲：存在订阅者时，`emit` 需要配合订阅者交付；没有订阅者时，`tryEmit` 可以成功而值随即丢失。

因此，`replay = 0` 可以避免新页面重放旧提示，但也意味着页面停止收集期间可能丢掉提示。导航、支付结果、保存结果是否允许这样丢失，需要分别判断。必须跨页面重建保留的结果，更适合成为状态中的待处理信息，或保存在有明确确认机制的数据层。

## 热流与界面生命周期是两件事

界面收集应跟随可见生命周期。Android View 系统中可以用 `repeatOnLifecycle`，Compose 中可以用 `collectAsStateWithLifecycle`。页面停止收集后，StateFlow 的当前状态仍可在恢复时获得；SharedFlow 的恢复行为则由 replay 决定。

从冷流转成共享状态时，`stateIn` 还需要一个实际拥有该任务的 scope：

```kotlin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn

/** Share the current list while the owning scope remains alive. */
fun Flow<List<String>>.shareListState(scope: CoroutineScope): StateFlow<List<String>> =
    stateIn(
        scope = scope,
        started = SharingStarted.WhileSubscribed(stopTimeoutMillis = 5_000),
        initialValue = emptyList(),
    )
```

这里的 5 秒用于吸收短暂的订阅空窗；拥有它的 scope 取消时，共享任务也会结束。`flowOn` 调整冷流上游的执行上下文，对已经存在的 StateFlow 没有效果；StateFlow 的更新由写入它的代码负责。

状态模型、共享策略和收集生命周期分别确定之后，Flow 的选择通常就清楚了：状态需要一个可读的最新快照，广播需要明确的重放和丢弃规则，重要结果需要明确的保存与确认过程。

## 参考

- [Kotlin：StateFlow API](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-core/kotlinx.coroutines.flow/-state-flow/)
- [Kotlin：SharedFlow API](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-core/kotlinx.coroutines.flow/-shared-flow/)
- [Kotlin：MutableStateFlow.update](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-core/kotlinx.coroutines.flow/update.html)
- [Android Developers：StateFlow and SharedFlow](https://developer.android.com/kotlin/flow/stateflow-and-sharedflow)
