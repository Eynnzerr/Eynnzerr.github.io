---
title: '从 volatile 到锁：共享状态需要怎样的同步'
description: '从一次丢失更新推导可见性、原子性与 happens-before，比较 volatile、原子类、synchronized、ReentrantLock 和协程 Mutex 的适用边界。'
date: '2026-02-28T22:00:54+08:00'
categories: [Java, 并发]
tags: [Java, JVM, volatile, 原子操作, 锁, Kotlin]
updated: '2026-10-15'
---

多个线程共享状态时，需要先确定哪一组操作必须作为整体完成。只发布一个标志、给计数器加一、同时修改两项库存，要求的同步能力并不相同。

`volatile` 建立读写之间的可见性与顺序关系，原子类提供特定状态转换，锁则可以保护一整段临界区。把问题落到具体的读写过程上，比单独记忆它们的特点更容易作出选择。

## 看得见更新，仍然可能丢失更新

假设两个线程对同一个 `volatile int count` 执行 `count++`，初始值为 `0`。下面是一种可能的交错：

| 时刻 | 线程 A | 线程 B |
| --- | --- | --- |
| 1 | 读取 `count = 0` | |
| 2 | | 读取 `count = 0` |
| 3 | 计算 `0 + 1`，写入 `1` | |
| 4 | | 计算 `0 + 1`，写入 `1` |

每一次读写都遵守 `volatile` 的规则，最终结果却只有 `1`。原因是“读取、加一、写回”组成了一个复合操作，两个线程在它完成前交错执行了。

这里需要区分三个问题：

- **可见性**：一次读取能观察到哪些写入。
- **原子性**：一组操作能否作为不可分割的状态转换完成。
- **顺序关系**：哪些操作之间存在必须保留的先后约束。

同步机制的选择，要覆盖当前状态转换真正需要的保证。

## 用 happens-before 理解 volatile

Java 内存模型用 happens-before 描述可见性保证。对一个 `volatile` 变量的写，happens-before 后续对同一变量的读；程序顺序与 happens-before 的传递性还能把写入前的其他操作连接起来。

下面是一个只发布一次消息的例子：

```java
import java.util.OptionalInt;

/** Publishes one integer from one writer to any number of readers. */
final class OneShotMessage {
    /** Payload written before publication. */
    private int value;
    /** Publication flag; the writer changes it once from false to true. */
    private volatile boolean ready;

    /** Publishes the payload; called once by the designated writer. */
    public void publish(int message) {
        value = message;
        ready = true;
    }

    /** Returns the payload when publication has been observed. */
    public OptionalInt read() {
        if (!ready) {
            return OptionalInt.empty();
        }
        return OptionalInt.of(value);
    }
}
```

当读者观察到 `ready == true` 时，可以沿下面这条关系理解 `value` 的可见性：

```text
写入 value
  → 程序顺序 → volatile 写 ready = true
  → 同步关系 → volatile 读 ready 得到 true
  → 程序顺序 → 读取 value
```

这个协议依赖“发布一次后不再修改载荷”的条件。若要反复更新一组配置，可以把配置组织成不可变对象，再用一个 `volatile` 引用整体替换。引用发布后的对象内部若继续发生可变写入，那些操作还需要自己的同步协议。

用“强制刷主内存”记忆 `volatile` 容易把语言语义和硬件实现混在一起。JVM 可以通过不同指令和屏障实现规则，程序推理依赖的是 Java 内存模型允许观察到的结果。`Thread.sleep()` 和 `Thread.yield()` 本身没有建立这种同步关系。

## 原子类把状态转换封装成一个操作

对于单个计数器，可以直接使用原子操作：

```java
var completed = new java.util.concurrent.atomic.AtomicInteger();
int first = completed.incrementAndGet(); // 1
int second = completed.incrementAndGet(); // 2
```

`incrementAndGet()` 将加一作为原子转换完成。把它拆成 `get()` 再 `set()`，就又回到了读改写竞争。

“检查后修改”也是复合操作。例如 `if (available.get() > 0) available.decrementAndGet()` 仍可能让两个线程同时通过检查。可以用比较并交换，让检查的旧状态成为提交更新的条件：

```java
import java.util.concurrent.atomic.AtomicInteger;

/** Reserves one unit when the shared stock is positive. */
static boolean tryReserve(AtomicInteger available) {
    while (true) {
        int observed = available.get();
        if (observed <= 0) {
            return false;
        }
        if (available.compareAndSet(observed, observed - 1)) {
            return true;
        }
        // A competing update won; retry from a fresh observation.
    }
}
```

CAS 失败说明这次提交所依赖的观察已经失效，循环重新读取并判断。这个函数只维护非负库存这一项约束，没有在重试路径中扣款、发送通知等副作用。

`updateAndGet` 等函数式更新接口也可能重复调用更新函数，所以更新函数应当只计算新值。需要同时修改多个独立变量时，分别使用原子类仍无法自动形成一个整体事务。

## 锁保护的是一组相关状态

考虑库存的两个字段：可用数量和已预留数量。预留一件物品时，要把前者减一、后者加一，并让读取快照的线程看见一致结果：

```java
/** Maintains a fixed stock split between available and reserved units. */
final class Inventory {
    /** Units that can still be reserved; guarded by this instance. */
    private int available = 10;
    /** Units already reserved; guarded by this instance. */
    private int reserved = 0;

    /** Immutable inventory state observed under the lock. */
    public record Snapshot(int available, int reserved) {}

    /** Reserves one unit if stock remains. */
    public synchronized boolean reserve() {
        if (available == 0) {
            return false;
        }
        available--;
        reserved++;
        return true;
    }

    /** Reads both counters as one consistent snapshot. */
    public synchronized Snapshot snapshot() {
        return new Snapshot(available, reserved);
    }
}
```

这里所有相关读写都使用同一个实例监视器。`reserve()` 内部两次字段更新之间，其他线程无法通过 `snapshot()` 读到中间状态，于是 `available + reserved == 10` 在对外快照中始终成立。

`synchronized` 既提供互斥，也建立可见性：对一个监视器的解锁，happens-before 后续对同一个监视器的加锁。只给写方法加锁、让读方法直接访问字段，会破坏这套协议。

实例同步方法锁住 `this`；静态同步方法锁住对应的 `Class` 对象；同步代码块锁住括号中指定的对象。互斥发生在竞争同一把锁的调用之间。退出同步区域时，正常返回和异常退出都会释放监视器。

## ReentrantLock 增加获取锁的控制能力

`synchronized` 和 `ReentrantLock` 都支持同一线程重入，也都能保护临界区。需要可中断等待、限时尝试获取锁或多个 `Condition` 时，可以选择显式锁。

```java
import java.util.concurrent.locks.ReentrantLock;

/** Counts updates while allowing lock acquisition to be interrupted. */
final class InterruptibleCounter {
    /** Protects the counter value. */
    private final ReentrantLock lock = new ReentrantLock();
    /** Number of completed increments; guarded by lock. */
    private int value;

    /** Increments the value after acquiring the lock interruptibly. */
    public int increment() throws InterruptedException {
        lock.lockInterruptibly();
        try {
            return ++value;
        } finally {
            lock.unlock();
        }
    }
}
```

获取锁成功后才进入 `try`，并在 `finally` 中释放；如果获取过程中被中断，方法直接抛出异常，不会错误地解锁。

公平模式会倾向于把锁交给等待更久的线程，但线程调度仍由运行时和操作系统决定。无超时的 `tryLock()` 还允许直接抢到空闲锁，不遵守公平排队规则。公平策略的选择需要同时考虑等待分布与吞吐需求。

## 协程等待锁时，选择与挂起兼容的机制

`ReentrantLock` 的持有者是线程。协程挂起后可能换线程恢复，因此跨挂起点持有这种线程锁会与所有权规则冲突；争用平台线程上的阻塞锁，也会占用调度器的执行线程。

协程共享状态可以使用 `kotlinx.coroutines.sync.Mutex`：

```kotlin
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Maintains a quota shared by coroutines. */
class Quota(initial: Int) {
    /** Serializes access to the remaining quota. */
    private val mutex = Mutex()
    /** Remaining units; accessed only while holding mutex. */
    private var remaining = initial

    /** Takes one unit if any remain. */
    suspend fun take(): Boolean = mutex.withLock {
        if (remaining <= 0) {
            false
        } else {
            remaining--
            true
        }
    }
}
```

竞争 `Mutex` 时，等待者可以挂起，让执行线程处理其他协程。`Mutex` 不可重入，同一条调用链再次获取尚未释放的同一把锁会等待自己；使用 owner 标记时，相同 owner 的重复获取还可能直接报错。

挂起等待降低了等待期间占用线程的成本，临界区本身仍然应尽量短。把网络请求整个放在锁内，会让其他等待这份状态的协程一起排队。若把耗时操作移到锁外，则需要重新检查“读取状态 → 外部操作 → 提交结果”这三个阶段是否仍满足业务约束。

最终选择可以落在状态的形状上：单次发布标志或不可变快照引用使用 `volatile`；独立计数和明确的单值转换使用原子类；多个字段共同维护约束时使用同一把锁；协程中的可挂起互斥使用 `Mutex`。先把需要保持的条件写出来，再选择足以维护它的同步机制。

## 参考资料

- [Java 语言规范 17：线程、锁与 happens-before](https://docs.oracle.com/javase/specs/jls/se25/html/jls-17.html)
- [JDK 25：AtomicInteger](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/atomic/AtomicInteger.html)
- [JDK 25：ReentrantLock](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/locks/ReentrantLock.html)
- [kotlinx.coroutines：Mutex](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-core/kotlinx.coroutines.sync/-mutex/)
- [Kotlin：共享可变状态与并发](https://kotlinlang.org/docs/shared-mutable-state-and-concurrency.html)
