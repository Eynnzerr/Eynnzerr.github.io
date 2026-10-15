---
title: '把 Kotlin 协程的五个概念串成一条调用链'
description: '从一次并发加载出发，梳理 Coroutine、Continuation、Job、CoroutineContext 与 CoroutineScope，以及结构化并发中的完成、取消和异常传播。'
date: '2026-02-26T19:57:57+08:00'
categories: ['Kotlin', '协程']
tags: ['Kotlin', '结构化并发', 'CoroutineContext', 'Job']
updated: '2026-10-15'
---

协程代码容易读成顺序流程，但运行时仍然需要保存执行位置、选择执行线程，并追踪正在进行的子任务。`Continuation`、`CoroutineContext`、`CoroutineScope` 和 `Job` 分别承接这些职责。把它们放回一段真实形状的调用链，关系就会清楚很多。

## 一次需要两份数据的加载

假设页面需要资料和最近项目，两者可以独立加载：

```kotlin
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/** The two independently loaded parts of a profile screen. */
data class ProfilePage(
    /** Display name loaded from the profile source. */
    val name: String,
    /** Project names loaded independently. */
    val projects: List<String>,
)

/** Load both parts inside the caller's cancellation boundary. */
suspend fun loadProfilePage(
    loadName: suspend () -> String,
    loadProjects: suspend () -> List<String>,
): ProfilePage = coroutineScope {
    val name = async { loadName() }
    val projects = async { loadProjects() }
    ProfilePage(name.await(), projects.await())
}
```

两次 `async` 都在 `await` 之前启动，因此它们的执行过程可以重叠。若改成 `async { loadName() }.await()` 后再启动第二个任务，就失去了这种并发组织方式。是否在多个 CPU 核心上同时执行，仍由调度器和底层操作决定。

这个函数还有一个重要性质：它返回时，内部启动的工作已经结束。调用者取消，内部两项工作也属于取消范围；一项因普通异常失败，另一项会被取消，组合结果不再成立。

## 五个名称分别对应什么

| 概念 | 在上述调用中的职责 |
| --- | --- |
| Coroutine | 一段能够挂起、恢复并走向完成的执行过程 |
| Continuation | 承接挂起点之后的执行，以及恢复时的值或异常 |
| CoroutineContext | 以 Key 组合调度器、Job、名称等运行元素 |
| CoroutineScope | 为启动子协程提供 context 和生命周期边界 |
| Job | 追踪完成、取消与父子关系 |

`CoroutineContext` 可以按类型对应的 Key 取出元素：

```kotlin
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job

val context = Job() + Dispatchers.Default + CoroutineName("Profile")
val renamed = context + CoroutineName("ProfileReload")
```

第二次组合覆盖的是名称元素，原 context 的组合结构保持不变。context 是不可变的元素集合；其中的 Job 则维护自己的可变生命周期状态。

`CoroutineScope` 暴露 `coroutineContext`。`Continuation` 也带有一个 context，其核心操作是 `resumeWith(Result<T>)`，承接执行流程的恢复。Job 作为 context 的一个元素，负责生命周期。

在 kotlinx.coroutines 的内部实现中，一个协程对象可以同时实现这些接口，把生命周期管理、作用域和恢复逻辑组织在一起。

## 挂起时，执行位置去了哪里

考虑依次等待两项结果的逻辑：

```text
进入函数 → 启动 A、B → 等待 A → 保存 A 的结果 → 等待 B → 组装页面
```

如果等待 A 时结果还没准备好，后续流程需要暂存；A 完成后，把结果送到对应 continuation，再继续走向等待 B 的位置。Kotlin 编译器在需要跨挂起点保存状态时，会生成相应的状态机与字段，协程库负责调度和恢复。

`suspend` 表示函数具备挂起能力，实际是否挂起取决于执行路径。结果已经完成的 `await` 可以直接取得结果；一个只做普通计算的挂起函数会在当前执行线程上计算。

阻塞调用也保持其阻塞性质。`Thread.sleep()` 占住当前线程，`delay()` 则在需要等待时挂起协程。协程让等待可以交还执行资源，但 CPU 运算仍然需要真实线程和核心来完成。

## 父子关系通过 Job 建立

普通子协程启动时，会从 scope 提供的 context 中取得父 Job，再建立自己的 Job。子协程 context 中看到的是自己的 Job，父子关系另行维护：

```text
调用方 Job
└─ coroutineScope 的作用域 Job
   ├─ async：资料
   └─ async：项目列表
```

这棵树带来几个可用的规则：父协程取消会向下传播；父协程完成前要等待子任务；普通子任务失败会影响所属的普通父子范围。取消请求不等于工作已经彻底停止，`cancel()` 后如果还需要等待清理完成，可以使用 `cancelAndJoin()`。

生命周期也因此成为创建 scope 时最重要的问题。页面所属的工作用页面 scope，应用长期服务的工作用服务或应用拥有的 scope。把本来属于页面的请求丢进一个无人关闭的新 scope，只是把“谁来取消它”的问题藏了起来。

## launch、async 和作用域函数各管什么

| API | 调用得到什么 | 完成边界 |
| --- | --- | --- |
| `launch` | `Job` | 启动子任务，可等待或取消，不携带业务返回值 |
| `async` | `Deferred<T>` | 启动带结果的子任务，`await` 取得结果 |
| `coroutineScope` | 块的结果 `T` | 等待整个内部范围结束 |
| `supervisorScope` | 块的结果 `T` | 子任务之间允许独立失败，仍受 scope 生命周期约束 |
| `withContext` | 块的结果 `T` | 在更新后的 context 中执行并等待 |
| `runBlocking` | 块的结果 `T` | 阻塞调用线程，连接同步入口与协程代码 |

`launch` 的生命周期由所属 scope 管理。普通父子关系中的 `async` 失败会取消父范围，即使结果尚未被 `await()` 等待。

如果允许部分加载失败，就把这种选择体现在监督范围和结果处理中：

```kotlin
import java.io.IOException
import kotlinx.coroutines.async
import kotlinx.coroutines.supervisorScope

/** Keep the required name while tolerating an optional list's I/O failure. */
suspend fun loadPartialProfile(
    loadName: suspend () -> String,
    loadProjects: suspend () -> List<String>,
): ProfilePage = supervisorScope {
    val name = async { loadName() }
    val projects = async { loadProjects() }
    val loadedName = name.await()
    val loadedProjects = try {
        projects.await()
    } catch (failure: IOException) {
        emptyList()
    }
    ProfilePage(loadedName, loadedProjects)
}
```

项目列表的 I/O 失败被明确降级；资料失败仍会从块中抛出，结束整个加载。`supervisorScope` 只改变子任务失败传播规则，并不会自动替业务定义降级结果。

`CoroutineExceptionHandler` 服务于相应的未捕获异常边界。需要在失败后继续组成页面时，应在能够做出业务决定的调用位置捕获异常。

沿着代码追踪“scope 从哪里来、子 Job 属于谁、挂起结果交给哪个调用点”，比孤立记忆每个名称更容易定位问题。结构化并发的实际价值，就是让这些关系与函数和生命周期的边界保持一致。

## 参考

- [Kotlin：Coroutine context and dispatchers](https://kotlinlang.org/docs/coroutine-context-and-dispatchers.html)
- [Kotlin：Coroutine exceptions handling](https://kotlinlang.org/docs/exception-handling.html)
- [Kotlin：CoroutineScope API](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-core/kotlinx.coroutines/-coroutine-scope/)
- [Kotlin：Continuation API](https://kotlinlang.org/api/core/kotlin-stdlib/kotlin.coroutines/-continuation/)
