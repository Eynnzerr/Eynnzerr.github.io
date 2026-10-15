---
title: Handler 消息处理机制解析
date: '2025-08-29T20:44:42+08:00'
updated: '2026-03-03T07:54:30.357Z'
legacyPath: /2025/08/29/old-handler-src-analysis/
categories:
  - Android
tags:
  - Android
  - Handler
---

**该篇内容为原博客博文，原上传于2021年9月11日。**

# 前言
提到Android中的消息机制，想必大家对其都不陌生。Android消息机制，一般指handler和其附加的mq及looper的运行机制与工作过程。handler常用于解决在子线程不能访问UI的问题，举一个常见的例子：我们在子线程中执行了耗时工作后，需要对UI进行更新，但又不能直接在子线程更新UI（这是因为控件在重绘前会调用checkThread()检查当前是否为主线程，以防ANR）。此时我们就可以创建handler，并将要执行的代码逻辑写入一个runnable任务中，并调用handler的post(本质上仍是调用send)或send将任务提交给主线程的消息队列中，再由主线程的looper取出这个任务，在主线程执行，如此便自然地从子线程转入主线程，实现了UI的更新。当然我们也可以直接调用Activity类的runOnUiThread()方法，道理是一样的。下面就让我们一起从源码的角度探究handler消息处理机制的原理，以及handler使用存在的一些问题。

# handler的构造问题
handler有多个构造方法，我们常常用到的有以下几个：
1. 无参构造
```java
        @Deprecated
        public Handler() {
            this(null, false);
        }
```

这个构造方法已经弃用。其内部调用了另一个有参构造方法，但是传的值为null和false，让我们接下去看看：

```java
    public Handler(@Nullable Callback callback, boolean async) {
        if (FIND_POTENTIAL_LEAKS) {
            final Class<? extends Handler> klass = getClass();
            if ((klass.isAnonymousClass() || klass.isMemberClass() || klass.isLocalClass()) &&
                    (klass.getModifiers() & Modifier.STATIC) == 0) {
                Log.w(TAG, "The following Handler class should be static or leaks might occur: " +
                    klass.getCanonicalName());
            }
        }

        mLooper = Looper.myLooper();
        if (mLooper == null) {
            throw new RuntimeException(
                "Can't create handler inside thread " + Thread.currentThread()
                        + " that has not called Looper.prepare()");
        }
        mQueue = mLooper.mQueue;
        mCallback = callback;
        mAsynchronous = async;
    }
``` 

这里我们先解释一下这个构造方法的参数：callback是handler中定义的一个接口，用于简化构建handler的过程（可以用实现这个接口来避免自定义handler子类），下文再对这个接口做详细解释。这里传入值为null，说明我们不采用这种方式。async标志这个handler是否采用异步消息，下文再对handler的异步、普通和屏障消息作区别以及介绍同步屏障机制。这里传入false，说明我们默认采用的都是普通消息机制。
这个构造方法首先会通过FIND_POTENTIAL_LEAKS判断是否由可能存在的内存泄漏情况，如果有，则会输出日志警告我们。（不过我没有找到设置这个bool值为true的代码部分。。。）关于handler潜在的内存泄漏风险，下文会重点讨论。接着调用Looper.myLooper()尝试获取当前线程的looper。我们进入这个方法看看：

```java
    public static @Nullable Looper myLooper() {
        return sThreadLocal.get();
    }
```

调用了sThreadLocal的get方法并返回。那么sThreadLocal是什么呢？找到定义如下：

```java
    static final ThreadLocal<Looper> sThreadLocal = new ThreadLocal<Looper>();
```

发现这是一个ThreadLocal变量。关于ThreadLocal这里不做过多介绍（计划单独写一篇博客研究一下ThreadLocal，毕竟也是一个十分重要的知识点）。这样以来就明确了：每个线程只能有最多一个looper，并且存储在threadLocal里。调用get便可以得到当前线程的looper。但是除了主线程以外（主线程的消息机制下文会重点讨论），线程默认是没有looper的，需要自己通过prepare创建。如此，get方法就有可能返回null。当返回null时，就会抛出异常。以上我们可以得出一个结论：使用无参构造方法，必须确保当前线程持有looper，否则就会导致异常抛出。因此，这个方法被废弃也就不足为奇了。相应地，google建议我们使用另一个构造方法代替：

2. 
```java
    public Handler(@NonNull Looper looper) {
            this(looper, null, false);
        }
```

这个构造方法同样在内部调用了另一个构造方法：

```java
    public Handler(@NonNull Looper looper, @Nullable Callback callback, boolean async) {
        mLooper = looper;
        mQueue = looper.mQueue;
        mCallback = callback;
        mAsynchronous = async;
    }
```

可见这里直接使用了参数指定的looper，并获得了其对应的消息队列。

# MQ的工作原理
现在我们有了handler对象，并且这个handler内部持有某个线程的looper和messageQueue的对象。接着，就可以调用handler的send/post方法发送消息了。由于查看源码可以知道post方法本质上还是将runnable包装成message后调用send系列方法，所以这里就直接看send系列方法。譬如调用sendMessage方法：

```java
    public final boolean sendMessage(@NonNull Message msg) {
        return sendMessageDelayed(msg, 0);
    }
```

内部调用了另一个方法sendMessageDelayed。由此可见，我们也可以直接调用sendMessageDelayed并指定一个延迟时间，实现**定时任务**的效果。走进这个方法:

```java
    public final boolean sendMessageDelayed(@NonNull Message msg, long delayMillis) {
        if (delayMillis < 0) {
            delayMillis = 0;
        }
        return sendMessageAtTime(msg, SystemClock.uptimeMillis() + delayMillis);
    }
```

又调用了另一个方法sendMessageAtTime。走进这个方法：

```java
    public boolean sendMessageAtTime(@NonNull Message msg, long uptimeMillis) {
        MessageQueue queue = mQueue;
        if (queue == null) {
            RuntimeException e = new RuntimeException(
                    this + " sendMessageAtTime() called with no mQueue");
            Log.w("Looper", e.getMessage(), e);
            return false;
        }
        return enqueueMessage(queue, msg, uptimeMillis);
    }
```    

可以看见，首先方法试图获取一个消息队列，如果获取不到则会发出警告并返回false，那么消息则发送失败，不了了之。否则，接下来会调用enqueueMessage方法，走进这个方法：

```java
    private boolean enqueueMessage(@NonNull MessageQueue queue, @NonNull Message msg,
            long uptimeMillis) {
        msg.target = this;
        msg.workSourceUid = ThreadLocalWorkSource.getUid();

        if (mAsynchronous) {
            msg.setAsynchronous(true);
        }
        return queue.enqueueMessage(msg, uptimeMillis);
    }
```    

直接看最后一行，发现经过一系列方法，最终调用的是消息队列的enqueueMessage方法，也是消息队列工作较为重要的一个方法。走进这个方法：

```java
    boolean enqueueMessage(Message msg, long when) {
            if (msg.target == null) {
                throw new IllegalArgumentException("Message must have a target.");
            }

            synchronized (this) {
                if (msg.isInUse()) {
                    throw new IllegalStateException(msg + " This message is already in use.");
                }

                if (mQuitting) {
                    IllegalStateException e = new IllegalStateException(
                            msg.target + " sending message to a Handler on a dead thread");
                    Log.w(TAG, e.getMessage(), e);
                    msg.recycle();
                    return false;
                }

                msg.markInUse();
                msg.when = when;
                Message p = mMessages;
                boolean needWake;
                if (p == null || when == 0 || when < p.when) {
                    // New head, wake up the event queue if blocked.
                    msg.next = p;
                    mMessages = msg;
                    needWake = mBlocked;
                } else {
                    // Inserted within the middle of the queue.  Usually we don't have to wake
                    // up the event queue unless there is a barrier at the head of the queue
                    // and the message is the earliest asynchronous message in the queue.
                    needWake = mBlocked && p.target == null && msg.isAsynchronous();
                    Message prev;
                    for (;;) {
                        prev = p;
                        p = p.next;
                        if (p == null || when < p.when) {
                            break;
                        }
                        if (needWake && p.isAsynchronous()) {
                            needWake = false;
                        }
                    }
                    msg.next = p; // invariant: p == prev.next
                    prev.next = msg;
                }

                // We can assume mPtr != 0 because mQuitting is false.
                if (needWake) {
                    nativeWake(mPtr);
                }
            }
            return true;
        }
```        

虽然上面的代码比较长，但其实只做了一件很简单的事情：向消息队列插入当前消息。此外，需要留心其中最后的`nativeWake`调用，我们将在稍后介绍为什么 Looper 的`loop()`死循环不会卡死所在线程时再提到他。

首先，我们要了解消息队列底层采用的数据结构。虽然称作队列，其本质上只是一个普通的单链表。这点可从message类的源码印证：

```java
  ...
    // sometimes we store linked lists of these things
        @UnsupportedAppUsage
        /*package*/ Message next;
  ...
```

每个message对象都有一个next指针域。
enqueueMessage首先会对一些特殊情况进行处理，接着上了synchronize保证对链表的访问是线程安全的。接着分两种情况：第一次插入，唤醒阻塞的队列并创建新头，插入第一条消息，否则就尾插到链表尾部。
那么，looper是如何取出mq中的消息的呢？这里就要调用另一个方法next()了：

```java
    Message next() {
        // Return here if the message loop has already quit and been disposed.
        // This can happen if the application tries to restart a looper after quit
        // which is not supported.
        final long ptr = mPtr;
        if (ptr == 0) {
            return null;
        }

        int pendingIdleHandlerCount = -1; // -1 only during first iteration
        int nextPollTimeoutMillis = 0;
        for (;;) {
            if (nextPollTimeoutMillis != 0) {
                Binder.flushPendingCommands();
            }

            nativePollOnce(ptr, nextPollTimeoutMillis);

            synchronized (this) {
                // Try to retrieve the next message.  Return if found.
                final long now = SystemClock.uptimeMillis();
                Message prevMsg = null;
                Message msg = mMessages;
                if (msg != null && msg.target == null) {
                    // Stalled by a barrier.  Find the next asynchronous message in the queue.
                    do {
                        prevMsg = msg;
                        msg = msg.next;
                    } while (msg != null && !msg.isAsynchronous());
                }
                if (msg != null) {
                    if (now < msg.when) {
                        // Next message is not ready.  Set a timeout to wake up when it is ready.
                        nextPollTimeoutMillis = (int) Math.min(msg.when - now, Integer.MAX_VALUE);
                    } else {
                        // Got a message.
                        mBlocked = false;
                        if (prevMsg != null) {
                            prevMsg.next = msg.next;
                        } else {
                            mMessages = msg.next;
                        }
                        msg.next = null;
                        if (DEBUG) Log.v(TAG, "Returning message: " + msg);
                        msg.markInUse();
                        return msg;
                    }
                } else {
                    // No more messages.
                    nextPollTimeoutMillis = -1;
                }

                // Process the quit message now that all pending messages have been handled.
                if (mQuitting) {
                    dispose();
                    return null;
                }

                // If first time idle, then get the number of idlers to run.
                // Idle handles only run if the queue is empty or if the first message
                // in the queue (possibly a barrier) is due to be handled in the future.
                if (pendingIdleHandlerCount < 0
                        && (mMessages == null || now < mMessages.when)) {
                    pendingIdleHandlerCount = mIdleHandlers.size();
                }
                if (pendingIdleHandlerCount <= 0) {
                    // No idle handlers to run.  Loop and wait some more.
                    mBlocked = true;
                    continue;
                }

                if (mPendingIdleHandlers == null) {
                    mPendingIdleHandlers = new IdleHandler[Math.max(pendingIdleHandlerCount, 4)];
                }
                mPendingIdleHandlers = mIdleHandlers.toArray(mPendingIdleHandlers);
            }

            // Run the idle handlers.
            // We only ever reach this code block during the first iteration.
            for (int i = 0; i < pendingIdleHandlerCount; i++) {
                final IdleHandler idler = mPendingIdleHandlers[i];
                mPendingIdleHandlers[i] = null; // release the reference to the handler

                boolean keep = false;
                try {
                    keep = idler.queueIdle();
                } catch (Throwable t) {
                    Log.wtf(TAG, "IdleHandler threw exception", t);
                }

                if (!keep) {
                    synchronized (this) {
                        mIdleHandlers.remove(idler);
                    }
                }
            }

            // Reset the idle handler count to 0 so we do not run them again.
            pendingIdleHandlerCount = 0;

            // While calling an idle handler, a new message could have been delivered
            // so go back and look again for a pending message without waiting.
            nextPollTimeoutMillis = 0;
        }
    }
```

这段代码中涉及到许多值得注意的地方，比如同步屏障机制的实现等。但目前我们只关心next()方法的主要作用：取出消息队列中下一个消息。核心代码如下：

```java
            final long now = SystemClock.uptimeMillis();
            Message prevMsg = null;
            Message msg = mMessages;
            if (msg != null && msg.target == null) {
                // Stalled by a barrier.  Find the next asynchronousmessage in the queue.
                do {
                    prevMsg = msg;
                    msg = msg.next;
                } while (msg != null && !msg.isAsynchronous());
            }
            if (msg != null) {
                if (now < msg.when) {
                    // Next message is not ready.  Set a timeout to wake up when it is ready.
                    nextPollTimeoutMillis = (int) Math.min(msg.when - now, Integer.MAX_VALUE);
                } else {
                    // Got a message.
                    mBlocked = false;
                    if (prevMsg != null) {
                        prevMsg.next = msg.next;
                    } else {
                        mMessages = msg.next;
                    }
                    msg.next = null;
                    if (DEBUG) Log.v(TAG, "Returning message: " + msg);
                    msg.markInUse();
                    return msg;
                }
            } else {
                // No more messages.
                nextPollTimeoutMillis = -1;
            }

            // Process the quit message now that all pending messages have been handled.
            if (mQuitting) {
                dispose();
                return null;
            }
```

首先获取了当前系统时间now。接着开始遍历消息队列。如果遇到屏障，则跳过普通消息寻找下一个异步消息（暂且不管）。而如果遍历到的消息的when字段大于当前时间，说明这个消息还未准备好，于是不先取出而是设置了一个唤醒时间，等到时间时再取出。否则，取出当前消息，并返回给调用者（looper）。而如果迟迟没有返回，消息队列就会设置nextPollTimeoutMillis为-1，并无限循环地阻塞下去，直到取出并返回可用的消息。最后是消息队列退出时的一些善后操作。
如此以来，消息队列的工作原理我们就大致清晰了。

# Looper的工作原理
handler负责发送和接收消息，message queue负责按FIFO方式存储消息，而looper则负责无限期地从mq中取出消息并分发给handler。looper的核心方法是loop()。
我们先了解一些looper类的字段：

```java
    @UnsupportedAppUsage
    static final ThreadLocal<Looper> sThreadLocal = new ThreadLocal<Looper>();
    @UnsupportedAppUsage
    private static Looper sMainLooper;  // guarded by Looper.class
    private static Observer sObserver;

    @UnsupportedAppUsage
    final MessageQueue mQueue;
    final Thread mThread;
    private boolean mInLoop;

    @UnsupportedAppUsage
    private Printer mLogging;
    private long mTraceTag;
```

其中sThreadLocal我们已经不陌生了，用来保存不同线程的Looper对象；sMainLooper是主线程的looper，这个比较特殊。sObserver是用来处理事务的观察者（暂且不管）。mQueue用来保存消息队列，mThread是当前工作线程。mInLoop标记looper正在工作当中。mLogging是日志工具。

前面已经提到，每一个线程必须先构造looper，消息机制才能正常工作。那么我们就来看一看Looper的构造方法：

```java
    private Looper(boolean quitAllowed) {
        mQueue = new MessageQueue(quitAllowed);
        mThread = Thread.currentThread();
    }
```

可见这里就是简单地构造了looper对应的消息队列，并保存了当前的线程对象。值得注意的是，这个唯一的构造方法是私有的，说明我们不能直接通过new获取一个looper。相反，我们需要调用prepare()方法：

```java
    public static void prepare() {
        prepare(true);
    }

    private static void prepare(boolean quitAllowed) {
        if (sThreadLocal.get() != null) {
            throw new RuntimeException("Only one Looper may be created per thread");
        }
        sThreadLocal.set(new Looper(quitAllowed));
    }
```

在prepare方法中，我们会先尝试从threadLocal中获取looper，看看当前线程是否已经有looper了。如果有，将会抛出异常，以此保证每个线程只能持有最多一个looper对象。如果没有，就会构造looper并放入threadLocal中。

前面我们反复提到了主线程looper的特殊性。实际上，Looper类还提供了一个prepareMainLooper()方法：
```java
    @Deprecated
    public static void prepareMainLooper() {
        prepare(false);
        synchronized (Looper.class) {
            if (sMainLooper != null) {
                throw new IllegalStateException("The main Looper has already been prepared.");
            }
            sMainLooper = myLooper();
        }
    }
```  

这个方法原本用于让ActivityThread创建主线程looper，但现在安卓环境会自己帮你创建，于是这个方法就被废弃了。现在，我们只需要知道主线程looper是系统自身已经创建好的，不需要自己再调用prepare方法创建。
下面我们开始介绍loop()方法。只有调用了loop()，消息循环才能真正起作用。

```java
    public static void loop() {
        final Looper me = myLooper();
        if (me == null) {
            throw new RuntimeException("No Looper; Looper.prepare() wasn't called on this thread.");
        }
        if (me.mInLoop) {
            Slog.w(TAG, "Loop again would have the queued messages be executed"
                    + " before this one completed.");
        }

        me.mInLoop = true;
        final MessageQueue queue = me.mQueue;

        // Make sure the identity of this thread is that of the local process,
        // and keep track of what that identity token actually is.
        Binder.clearCallingIdentity();
        final long ident = Binder.clearCallingIdentity();

        // Allow overriding a threshold with a system prop. e.g.
        // adb shell 'setprop log.looper.1000.main.slow 1 && stop && start'
        final int thresholdOverride =
                SystemProperties.getInt("log.looper."
                        + Process.myUid() + "."
                        + Thread.currentThread().getName()
                        + ".slow", 0);

        boolean slowDeliveryDetected = false;

        for (;;) {
            Message msg = queue.next(); // might block
            if (msg == null) {
                // No message indicates that the message queue is quitting.
                return;
            }

            // This must be in a local variable, in case a UI event sets the logger
            final Printer logging = me.mLogging;
            if (logging != null) {
                logging.println(">>>>> Dispatching to " + msg.target + " " +
                        msg.callback + ": " + msg.what);
            }
            // Make sure the observer won't change while processing a transaction.
            final Observer observer = sObserver;

            final long traceTag = me.mTraceTag;
            long slowDispatchThresholdMs = me.mSlowDispatchThresholdMs;
            long slowDeliveryThresholdMs = me.mSlowDeliveryThresholdMs;
            if (thresholdOverride > 0) {
                slowDispatchThresholdMs = thresholdOverride;
                slowDeliveryThresholdMs = thresholdOverride;
            }
            final boolean logSlowDelivery = (slowDeliveryThresholdMs > 0) && (msg.when > 0);
            final boolean logSlowDispatch = (slowDispatchThresholdMs > 0);

            final boolean needStartTime = logSlowDelivery || logSlowDispatch;
            final boolean needEndTime = logSlowDispatch;

            if (traceTag != 0 && Trace.isTagEnabled(traceTag)) {
                Trace.traceBegin(traceTag, msg.target.getTraceName(msg));
            }

            final long dispatchStart = needStartTime ? SystemClock.uptimeMillis() : 0;
            final long dispatchEnd;
            Object token = null;
            if (observer != null) {
                token = observer.messageDispatchStarting();
            }
            long origWorkSource = ThreadLocalWorkSource.setUid(msg.workSourceUid);
            try {
                msg.target.dispatchMessage(msg);
                if (observer != null) {
                    observer.messageDispatched(token, msg);
                }
                dispatchEnd = needEndTime ? SystemClock.uptimeMillis() : 0;
            } catch (Exception exception) {
                if (observer != null) {
                    observer.dispatchingThrewException(token, msg, exception);
                }
                throw exception;
            } finally {
                ThreadLocalWorkSource.restore(origWorkSource);
                if (traceTag != 0) {
                    Trace.traceEnd(traceTag);
                }
            }
            if (logSlowDelivery) {
                if (slowDeliveryDetected) {
                    if ((dispatchStart - msg.when) <= 10) {
                        Slog.w(TAG, "Drained");
                        slowDeliveryDetected = false;
                    }
                } else {
                    if (showSlowLog(slowDeliveryThresholdMs, msg.when, dispatchStart, "delivery",
                            msg)) {
                        // Once we write a slow delivery log, suppress until the queue drains.
                        slowDeliveryDetected = true;
                    }
                }
            }
            if (logSlowDispatch) {
                showSlowLog(slowDispatchThresholdMs, dispatchStart, dispatchEnd, "dispatch", msg);
            }

            if (logging != null) {
                logging.println("<<<<< Finished to " + msg.target + " " + msg.callback);
            }

            // Make sure that during the course of dispatching the
            // identity of the thread wasn't corrupted.
            final long newIdent = Binder.clearCallingIdentity();
            if (ident != newIdent) {
                Log.wtf(TAG, "Thread identity changed from 0x"
                        + Long.toHexString(ident) + " to 0x"
                        + Long.toHexString(newIdent) + " while dispatching to "
                        + msg.target.getClass().getName() + " "
                        + msg.callback + " what=" + msg.what);
            }

            msg.recycleUnchecked();
        }
    }
```

提取出核心代码，其实loop的工作非常简单：

```java
    for (;;) {
        Message msg = queue.next(); // might sleep
        if (msg == null) {
            // No message indicates that the message queue is quitting.
            return;
        }
    }
```

就是无限循环地调用mq的next()方法，直到mq退出返回Null。什么时候mq返回null呢？当looper调用quit方法：

```java
    public void quit() {
        mQueue.quit(false);
    }
```    

会接着调用mq的quit:

```java
    void quit(boolean safe) {
        if (!mQuitAllowed) {
            throw new IllegalStateException("Main thread not allowed to quit.");
        }

        synchronized (this) {
            if (mQuitting) {
                return;
            }
            mQuitting = true;

            if (safe) {
                removeAllFutureMessagesLocked();
            } else {
                removeAllMessagesLocked();
            }

            // We can assume mPtr != 0 because mQuitting was previously false.
            nativeWake(mPtr);
        }
    }
```    

这里将消息队列的mQuitting设置为了true。再看next()中的一段代码：

```java
    // Process the quit message now that all pending messages have been handled.
    if (mQuitting) {
        dispose();
        return null;
    }
```

由此可见，looper调用quit时，mq就会退出。消息循环终止。
现在，我们有了looper，当Looper从mq中取出了一条消息时，就会对其进行处理：

```java
    msg.target.dispatchMessage(msg);
```    

其中，msg.target就是发送这条消息的对象。也就是说，当我们使用handler发送一条消息后，这条消息经过放入mq，再被looper取出，又被looper分发给了同一个handler。只不过handler对象虽然是同一个，发送和接收消息时所处的线程却不一定相同。下面我们一探handler的dispatchMessage()方法：

# Handler的工作原理
如何使用handler发送消息，已经在介绍MQ时说过了。我们主要看一看handler是如何处理Looper取出的消息的：

```java
    public void dispatchMessage(@NonNull Message msg) {
        if (msg.callback != null) {
            handleCallback(msg);
        } else {
            if (mCallback != null) {
                if (mCallback.handleMessage(msg)) {
                    return;
                }
            }
            handleMessage(msg);
        }
    }
```

首先会检查消息中的callback是否为空，这里callback就是通过post方式提交的runnable对象。如果不为空，进一步调用handleCallback()方法，这个方法也很简单：

```java
    private static void handleCallback(Message message) {
        message.callback.run();
    }
```    

就是执行runnable的run方法，完成其中的任务。

如果callback为空，会接着检查mCallback是否为空。前面我们已经介绍过，mCallback是handler内部定义的一个接口，提供了另一种使用Handler的方式：Handler handler = new Handler(Callback)，这时就会按照callback内部的处理逻辑（自己在创建时实现）来处理方法。最后，如果mCallback为空，说明处理的是普通的message。调用handleMessage(必须在创建handler时重写，默认是一个空的方法)来处理即可。
这样，我们就大致搞清楚了handler消息机制的主要工作原理，即handler,mq,looper三大件各自的作用及使用方法。handler使用简单，快捷，但也存在一个一直为人诟病的潜在问题：**内存泄露**。下面我们就来探讨handler引发内存泄露的问题和常用的解决方案。

# Handler内存泄漏

众所周知在java中，成员对象会默认隐式地持有外部类的对象。假设现在我们在MainActivity中创建了一个handler对象，那么这个handler也就持有了MainActivity的引用。现在考虑这样一种情况：如果向handler提交了一组任务，当handler还在处理任务的时候退出MainActivity会怎么样？

正常来说，MainActivity应该被回收并释放。但由于此时handler仍在处理正在进行的任务而存在，其持有MainActivity的引用，导致gc无法及时对MainActivity进行回收。如此一来，便发生了内存泄露。

通常情况下，handler的内存泄露都是暂时的，当其中的任务全部处理完毕时，内存还是会得到释放。但有问题就应该解决，以防止更大的问题产生。如何规避这种情况呢？

首先我们可以想到，将handler加上static修饰，**变成静态内部类**，这样handler就不会再隐式持有activity的引用了。但是这样，就又产生了一个问题：静态的handler无法访问activity实例，如果要用到activity的资源怎么办？

方法很简单，让handler持有外部activity的**弱引用**不就好了？弱引用会在仅弱可达时遇到gc就被回收，这样就基本上解决了问题。

最后，我们上一个演示实例。假设现在有这样一个需求：进入app时展示欢迎界面，一段时间后跳转至另一界面。一个简单的实现是准备两个activity，用handler实现定时intent跳转。

我们采用自定义handler的方式：

```java
    static class MyHandler extends Handler {
        WeakReference<WelcomeActivity> mactivity;

        public MyHandler(@NonNull Looper looper, WelcomeActivity activity){
            super(looper);//调用父类的显式指明的构造函数
            mactivity = new WeakReference<WelcomeActivity>(activity);
        }

        @Override
        public void handleMessage(Message msg) {
            super.handleMessage(msg);

            WelcomeActivity nactivity = mactivity.get();
            if(nactivity == null)
                return ;

            switch (msg.what) {
                case 0:
                    Intent intent = new Intent(mactivity.get(), LoginActivity.class);
                    mactivity.get().startActivity(intent);
                    mactivity.get().finish();
                    break;
                default:
                    break;
            }
        }
    }
```

可以看到我这里就采用了static和weakReference来避免内存泄露和引用activity。创建handler实例后，在activity的onCreate()中调用handler.sendEmptyMessageDelayed(0,3000);即可实现功能。

# Looper.loop() 为什么不会卡死线程

因为这里的底层其实用了**linux epoll**机制，在没消息时或有消息没到时间时`epoll_wait()`休眠，此时不占用 CPU。在消息到时间或者来了新消息时`nativeWake`写fd唤醒。

epoll 是 Linux 内核提供的 **IO 多路复用**机制，线程可以在一个文件描述符（fd）上等待，**不消耗 CPU**，有事件时内核唤醒线程。

从消息队列拿不到新消息时：调用 epoll_wait(fd, -1) → 线程进入内核态休眠 → CPU 不会分配时间片给这个线程 → 零 CPU 消耗。

有新消息时：也就是消息队列的 enqueueMessage() → nativeWake() → write(mWakeEventFd, 1) → epoll_wait() 返回 → next() 继续执行，取出消息。

# 结语

handler消息机制是android开发重要的功能，需要我们清楚其原理和实现。

这是我第一次尝试自主分析源码，因此文章中可能存在错误，以及一些理解不够深入。欢迎大佬提出问题并指正！
