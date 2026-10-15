---
title: 'Java 线程池：从任务提交到排队、扩容与关闭'
description: '用一个容量确定的 ThreadPoolExecutor 推导任务去向，理解核心线程、阻塞队列、拒绝策略、Future 异常与线程池关闭。'
date: '2026-02-22T16:09:50+08:00'
categories: [Java, 并发]
tags: [Java, 线程池, ThreadPoolExecutor, ExecutorService]
updated: '2026-10-15'
---

线程池把两件事分开：调用方提交任务，工作线程负责执行任务。一个工作线程完成当前任务后，可以继续从队列中取下一个任务，避免为每个短任务重新创建线程。

更重要的是，线程池提供了一组容量边界：最多同时使用多少线程、最多积压多少任务、超出容量时如何回应。理解 `ThreadPoolExecutor`，应先追踪一项任务会去哪里，再看每个参数的含义。

## 一项新任务会经历哪些判断

对于仍在运行、线程创建正常的线程池，`execute` 的主要路径是：

```text
当前工作线程数 < corePoolSize
    → 尝试创建工作线程，直接执行该任务
否则尝试把任务加入队列
    → 入队成功，等待工作线程领取
    → 入队失败，尝试增加工作线程，直到 maximumPoolSize
仍无法接收
    → 执行拒绝策略
```

这个顺序解释了一个常见现象：`maximumPoolSize` 明明很大，任务却一直排队。达到核心线程数后，线程池优先使用队列；只要队列还能接收任务，就不会仅仅因为已有线程都忙而继续扩容。

实际实现还会复查线程池状态，处理“刚入队就发生关闭”等并发变化。关闭状态下的新提交也会触发拒绝。

## 用七个任务看清容量变化

设核心线程数为 `2`，最大线程数为 `4`，队列容量为 `2`。提交七个任务，并让已开始的任务等待同一个闸门，确保提交期间没有任务提前结束：

```java
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Demonstrates a bounded pool while all running tasks wait at a gate. */
public class PoolCapacityDemo {
    /** Submits seven tasks and then releases accepted work. */
    public static void main(String[] args) throws InterruptedException {
        var gate = new CountDownLatch(1);
        var pool = new ThreadPoolExecutor(
            2,
            4,
            30,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<Runnable>(2),
            new ThreadPoolExecutor.AbortPolicy()
        );

        try {
            for (int id = 1; id <= 7; id++) {
                final int taskId = id;
                try {
                    pool.execute(() -> {
                        try {
                            gate.await();
                            System.out.println("completed: " + taskId);
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                        }
                    });
                    System.out.println("accepted: " + taskId);
                } catch (RejectedExecutionException rejected) {
                    System.out.println("rejected: " + taskId);
                }
            }
        } finally {
            gate.countDown();
            pool.shutdown();
        }

        if (!pool.awaitTermination(5, TimeUnit.SECONDS)) {
            pool.shutdownNow();
        }
    }
}
```

在闸门打开前，任务去向如下：

| 任务 | 决策 | 工作线程数 | 队列中任务数 |
| --- | --- | --- | --- |
| 1 | 未达到核心数，创建线程 | 1 | 0 |
| 2 | 未达到核心数，创建线程 | 2 | 0 |
| 3 | 达到核心数，入队 | 2 | 1 |
| 4 | 继续入队 | 2 | 2 |
| 5 | 队列已满，创建线程 | 3 | 2 |
| 6 | 队列已满，创建线程 | 4 | 2 |
| 7 | 队列与线程数均到上限，拒绝 | 4 | 2 |

任务 5、6 会直接交给新工作线程，因此可以比队列中的任务 3、4 更早开始执行。队列使用 FIFO，也只能约束排队任务的领取顺序，整个线程池的任务开始和完成顺序仍受扩容与调度影响。

这里的 `2 / 4 / 2` 用于展示机制。实际容量需要结合任务耗时、下游连接数和可接受的等待时间确定。

## 队列决定了容量如何使用

线程池参数应与队列一起看：

| 队列方式 | 任务接收方式 | 对扩容的影响 |
| --- | --- | --- |
| `ArrayBlockingQueue(n)` | 最多缓存 `n` 个任务 | 达到容量后才尝试扩容 |
| `LinkedBlockingQueue(n)` | 链表实现的有界队列 | 同样受显式容量约束 |
| 未指定容量的 `LinkedBlockingQueue` | 容量上限为 `Integer.MAX_VALUE` | 通常持续排队，最大线程数很难发挥作用 |
| `SynchronousQueue` | 将任务直接交给等待接收的线程，不存储任务 | 无法立即交接时，尝试扩容或拒绝 |

`BlockingQueue` 的“阻塞”描述的是队列提供的操作能力。线程池提交任务时使用非阻塞的入队尝试；队列满了会进入扩容或拒绝路径。工作线程等待新任务时，则可以在取任务的操作上等待。

大队列能够吸收短时突发，也会让任务在真正执行前等得更久。假设稳定处理能力为每秒 100 项，而持续每秒提交 120 项，排队量每秒净增约 20 项。增加队列容量只是延后耗尽时间，长期吞吐缺口仍需减少输入、增加有效处理能力或缩短任务耗时。

## 拒绝策略是调用方能够观察到的行为

默认 `AbortPolicy` 抛出 `RejectedExecutionException`，调用方可以明确知道任务没有被接收。其他内置策略会改变这种语义：

- `CallerRunsPolicy`：线程池运行时，让提交任务的线程亲自执行任务。提交过程因此变慢，可形成简单的反馈；若提交方是 UI 线程或事件循环，也会占用它。线程池已经关闭时，这个策略会丢弃任务。
- `DiscardPolicy`：直接丢弃任务，适用于业务本来就接受丢失的场景。
- `DiscardOldestPolicy`：线程池运行时移除队列头的任务，再尝试提交新任务。被移除的任务如何通知调用方，需要一并设计。

如果使用 `submit` 返回 `Future`，静默丢弃可能让调用方拿到一个长期不完成的 `Future`。任务接收失败应当如何反馈，需要和业务的重试、超时及结果等待一起考虑。

## 线程复用、空闲与退出

核心线程默认按需创建。需要预热时可以调用 `prestartCoreThread` 或 `prestartAllCoreThreads`。

`keepAliveTime` 控制空闲线程等待多久后退出，默认用于超过核心数的部分。启用 `allowCoreThreadTimeOut(true)` 后，核心范围内的线程也可以在空闲超时后退出，此时存活时间必须大于零。

“核心”和“非核心”描述的是池规模控制规则。工作线程等待超时、执行流程结束后，底层线程终止；相关 Java 对象在不再可达时才进入垃圾回收的考虑范围。这是两个相邻但不同的生命周期。

## execute 与 submit 的异常在哪里

`execute(Runnable)` 没有返回结果通道。任务抛出未捕获异常时，会沿工作线程的异常处理路径传播；线程池可能创建替代工作线程，以继续处理后续任务。

`submit` 会把任务包装成可记录完成状态的对象，并返回 `Future`。任务失败通常保存在这个结果中，调用 `get()` 时以 `ExecutionException` 交给调用方。只提交任务而从不检查结果，可能错过失败。

```java
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;

/** Observes a task's failure through its Future. */
static void observeFailure(ExecutorService pool) throws InterruptedException {
    var result = pool.submit(() -> Integer.parseInt("not-a-number"));
    try {
        result.get();
    } catch (ExecutionException failed) {
        System.err.println(failed.getCause());
    }
}
```

这个方法接收一个运行中的线程池，将等待期间的中断交给调用方处理。`submit` 适用于需要结果、取消句柄或明确完成状态的场景。

## 关闭是任务生命周期的一部分

`shutdown()` 停止接收新任务，已接收的任务继续执行。它立即返回；`awaitTermination` 用于等待线程池真正终止。

`shutdownNow()` 尝试中断正在执行的任务，并返回尚未开始的排队任务。正在执行的代码需要响应中断，线程池才能及时结束。例如可中断等待收到 `InterruptedException` 后退出，计算循环检查中断标记后停止。

因此，关闭逻辑通常包含“停止接收 → 等待一段时间 → 尝试中断 → 处理仍未结束或未执行的任务”。等待线程本身被中断时，也应沿调用链传播中断，或恢复中断标记后结束当前流程。

容量选择可以从具体约束出发：CPU 密集任务关注可用处理器与竞争；阻塞任务还要看数据库、网络服务和连接池能承受的并发。Java 21 引入的虚拟线程适合大量等待型任务，但其使用方式通常是每个任务一个虚拟线程；下游资源仍需要单独限制。这里讨论的 `ThreadPoolExecutor`，则通过复用有限数量的工作线程管理任务执行。

## 参考资料

- [JDK 25：ThreadPoolExecutor](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html)
- [JDK 25：ExecutorService 与关闭语义](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/ExecutorService.html)
- [JDK 25：Executors](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/Executors.html)
- [JDK 25：Future](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/Future.html)
- [JDK 25：虚拟线程指南](https://docs.oracle.com/en/java/javase/25/core/virtual-threads.html)
