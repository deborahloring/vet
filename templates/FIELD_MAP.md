# Approved master invoice field mapping

The owner-approved `paws-and-order-fillable-invoice.pdf` has **73 editable fields**. This master remains unchanged. Generated copies may be flattened and must preserve the original botanical/carrot border, layout and typography.

| PDF field | Data source |
|---|---|
| `invoice_no`, `issue_date`, `visit_date`, `visit_id` | `visits` same-name columns |
| `client_name`, `client_address_1`, `client_phone` | `clients.client_name`, `clients.address`, `clients.phone` |
| `client_address_2` | blank |
| `patient_name`, `breed`, `age` | `patients.pet_name`, `patients.breed`, `patients.age_years` |
| `attending_veterinarian`, `visit_type` | `visits.veterinarian`, `visits.visit_type` |
| `service_1_code` through `service_7_amount` | `invoice_items` for `section=service`; per row keys `code`, `description`, `qty` (source `quantity`), `unit_price`, `amount` |
| `product_1_code` through `product_3_amount` | Same keys in `section=product` |
| `services_total`, `products_total`, `subtotal`, `discount`, `tax`, `total_due` | `invoice_totals` same-name columns |
| `visit_note_1` through `visit_note_4` | `visits.visit_notes`, wrapped to ≤4 separate lines |

The PDF generator must **never read private answer keys** to fill pages. Displayed errors are intentional test inputs. Validate appearance streams, text extraction, page rendering, input note fit and zero remaining form widgets for every completed PDF.
