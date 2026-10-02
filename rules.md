Khi implement code, hãy ưu tiên chất lượng production thay vì chỉ làm cho chạy được.

Yêu cầu bắt buộc:

1. Viết code LEAN

* Cú pháp ngắn gọn nhưng không được hy sinh readability.
* Không over-engineering.
* Không tạo abstraction, helper, service, wrapper hoặc class nếu không thực sự cần thiết.
* Không duplicate logic.
* Ưu tiên early return, guard clause và flow đơn giản thay vì nested if/else sâu.
* Một function chỉ nên chịu một trách nhiệm rõ ràng.
* Tên biến/function phải thể hiện đúng intent.

2. Code phải dễ maintain

* Người khác đọc phải hiểu nhanh luồng xử lý.
* Tránh magic value, hidden side effect và implicit behavior.
* Tách business logic khỏi I/O, database, network và framework logic khi hợp lý.
* Giữ dependency direction rõ ràng.
* Không tạo coupling không cần thiết.
* Không viết clever code chỉ để giảm vài dòng nếu làm code khó hiểu.

3. Tối ưu performance ngay từ thiết kế
   Trước khi code, hãy kiểm tra:

* Time complexity.
* Memory complexity.
* Số lần query database.
* Số network call.
* Số lần loop/traverse dữ liệu.
* Object/array allocation không cần thiết.
* Copy/clone/serialize/deserialize không cần thiết.
* Blocking operation.
* N+1 query.
* Sequential await không cần thiết.
* Promise/concurrency không được kiểm soát.
* Event-loop blocking.
* Memory leak.
* Queue/task tăng không giới hạn.

Không micro-optimize vô nghĩa; tập trung vào bottleneck thực sự.

4. Mọi workload phải BOUNDED

Không được tạo xử lý có khả năng tăng vô hạn theo traffic.

Ví dụ phải tránh:
Promise.all(hugeArray.map(...))
unbounded queue
unbounded retry
load toàn bộ record vào memory
query không LIMIT
loop không có giới hạn
cache không TTL/max-size
spawn task không kiểm soát concurrency

Phải sử dụng khi thích hợp:

* concurrency limit
* batching
* pagination
* streaming
* chunking
* timeout
* retry có giới hạn + exponential backoff
* circuit breaker
* rate limit
* backpressure
* connection pooling
* queue size limit

5. Low latency

Ưu tiên giảm critical path.

Không thực hiện tuần tự những operation độc lập.

Ví dụ:

Không ưu tiên:
const a = await getA();
const b = await getB();

Nếu độc lập, ưu tiên:
const [a, b] = await Promise.all([
getA(),
getB(),
]);

Nhưng Promise.all chỉ được sử dụng trực tiếp khi số lượng task đã bounded.

Nếu input lớn phải giới hạn concurrency.

6. Database

Luôn kiểm tra:

* Có query thừa không?
* Có N+1 không?
* Có thể batch query không?
* Có SELECT dư field không?
* Có index phù hợp không?
* Có pagination/limit không?
* Transaction có giữ quá lâu không?
* Có query chạy bên trong loop không?

Chỉ lấy dữ liệu thật sự cần.

Không load dataset lớn vào RAM nếu có thể filter/aggregate/paginate ở database.

7. Error handling

Không swallow error.

Error phải:

* có context
* có error type/code phù hợp
* không làm mất stack trace
* rollback transaction đúng
* cleanup resource đúng
* không retry những lỗi không thể recover
* retry phải có giới hạn

Không dùng catch chỉ để throw lại cùng một error nếu không bổ sung giá trị.

8. Resource management

Mọi resource phải có lifecycle rõ ràng:

* DB connection
* stream
* file
* socket
* timer
* listener
* subscription
* worker
* Redis connection

Không để resource leak.

9. Concurrency safety

Kiểm tra:

* race condition
* duplicate processing
* double write
* lost update
* transaction conflict
* idempotency
* distributed lock nếu thực sự cần

Không dùng lock nếu database constraint, atomic operation hoặc optimistic concurrency có thể giải quyết đơn giản hơn.

10. Cache

Chỉ cache khi có lý do.

Nếu sử dụng cache phải xác định:

* key
* TTL
* invalidation
* max size
* cache stampede
* stale data strategy

Không sử dụng cache để che một thiết kế database/query kém.

11. Khi review code

Không chỉ hỏi:
"Code có chạy không?"

Phải hỏi:

* Có cách đơn giản hơn không?
* Có đoạn code nào dư không?
* Có thể giảm query/network call không?
* Có operation nào có thể chạy song song an toàn không?
* Có workload nào unbounded không?
* Khi traffic tăng 10x/100x chuyện gì xảy ra?
* Memory có tăng theo input không?
* Có bottleneck trên critical path không?
* Có race condition không?
* Có failure mode nào chưa xử lý không?
* Có dễ debug/monitor không?
* 6 tháng sau người khác có maintain được không?

12. Quy tắc cuối cùng

Ưu tiên theo thứ tự:

Correctness
→ Simplicity
→ Maintainability
→ Predictable resource usage
→ Low latency
→ Throughput
→ Optimization

Không tối ưu bằng cách làm code khó hiểu.

Mục tiêu là:

"Minimum code necessary, maximum clarity, bounded resource usage, predictable performance."

Trước khi trả code cuối cùng:

1. Review lại implementation.
2. Loại bỏ code dư.
3. Simplify flow.
4. Kiểm tra complexity.
5. Kiểm tra DB/network I/O.
6. Kiểm tra concurrency.
7. Kiểm tra memory/resource leak.
8. Kiểm tra khả năng overload.
9. Kiểm tra error/transaction.
10. Chỉ sau đó mới đưa ra implementation cuối cùng.
